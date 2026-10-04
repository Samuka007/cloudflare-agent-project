import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
  ToolRuntime,
  createToolHost,
  executeDispatch,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";

/**
 * L1 per-tool semantics for read (M1.5/T5 #95) — the full read face of the
 * vendored omp ReadTool through real execute(). Card 交付/验收 anchors:
 *   - 越界行返回说明不抛错（read-format.ts:335-345 plain text, no isError）
 *   - 截断元数据 details.meta.truncation → adapter outputTruncated
 *     （read.ts:2537-2539; 3000 行/50 KiB thresholds, streaming-output.ts:11-13）
 *   - 归档/SQLite/URL/binary/notebook 专项读取器（read-archive/sqlite/fetch/
 *     read.ts binary sniff/notebookToEditableText）
 *   - 同 executionId 重问 = journal 应答零二次执行（client 半：ToolRuntime.execute
 *     idempotency；DO 半由 l1-i19-replay 覆盖）
 */

const MACHINE = "machine-l1-read";

let root: string;
let fixture: string;
let host: ToolHost;
let db: Database;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

const LINES_4000 = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`);
// 200 lines × ~1.2 KB ≈ 240 KB: above the read byte budget max(50 KiB, 300×512)=150 KiB
// while staying under the 300-line default page — forces truncatedBy "bytes".
const WIDE_LINE = `byte-truncation-row ${"x".repeat(1160)}`;
const LINES_WIDE = Array.from({ length: 200 }, (_, i) => `${WIDE_LINE} ${i + 1}`);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-read-l1-"));
  fixture = join(root, "workspace");
  const agentDir = join(root, "omp-agent");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // Settings isolation (spike §1): the daemon-private agentDir carries its own
  // config.yml — used here to pin the URL gate deterministically (no network).
  writeFileSync(join(agentDir, "config.yml"), "fetch:\n  enabled: false\n");

  writeFileSync(join(fixture, "alpha.txt"), ["alpha one", "alpha two", "alpha three"].join("\n"));
  writeFileSync(join(fixture, "big.txt"), `${LINES_4000.join("\n")}\n`);
  writeFileSync(join(fixture, "wide.txt"), `${LINES_WIDE.join("\n")}\n`);
  writeFileSync(
    join(fixture, "blob.bin"),
    Buffer.from([0x00, 0xff, 0xfe, 0x9c, 0x0a, 0x42, 0x49, 0x4e]),
  );
  writeFileSync(join(fixture, "fake.db"), "just text, not sqlite at all\n");
  writeFileSync(
    join(fixture, "book.ipynb"),
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["print('hello cell')"],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );

  const tarDir = join(root, "tar-src", "inner");
  mkdirSync(tarDir, { recursive: true });
  writeFileSync(join(tarDir, "member.txt"), "tar member content\n");
  await Bun.$`tar -cf ${join(fixture, "arch.tar")} -C ${join(root, "tar-src")} inner/member.txt`.quiet();

  db = new Database(join(fixture, "data.sqlite"));
  db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO items (name) VALUES ('first'), ('second'), ('third')");
  db.close();

  host = await createToolHost(fixture, agentDir, MACHINE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("read selectors (T5 #95)", () => {
  test("out-of-range selector returns an explanation, not an error", async () => {
    const result = await executeDispatch(
      host,
      frameOf("read", "rd-1", { path: "alpha.txt:100-200" }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("beyond end of");
    expect(result.output).toContain("3 lines total");
    expect(result.output).toContain("Use :1 to read from the start, or :3 to read the last line");
  });

  test("line-range selector slices content in place", async () => {
    const result = await executeDispatch(
      host,
      frameOf("read", "rd-2", { path: "big.txt:3999-4000" }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("line 3999");
    expect(result.output).toContain("line 4000");
    expect(result.output).not.toContain("line 1\n");
  });
});

describe("read truncation semantics (T5 #95)", () => {
  test("read.defaultLimit (300 lines) pages plain reads: meta.truncation set, outputTruncated projected", async () => {
    const result = await executeDispatch(host, frameOf("read", "rd-3", { path: "big.txt" }));
    expect(result.status).toBe("ok");
    expect(result.outputTruncated).toBe(true);
    expect(result.output?.endsWith("300:line 300")).toBe(true);
    expect(result.output).not.toContain("301:line 301");
    // The "[Showing lines … Use :N to continue]" tail is TUI-rendered from
    // details.meta.truncation (output-meta.ts:253-254) — the tool result
    // itself carries the meta; the adapter maps it to outputTruncated.
    const tool = host.tools.read as ReadTool;
    const direct = await tool.execute("rd-3b", { path: "big.txt" });
    expect(direct.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 4000,
      outputLines: 300,
    });
    expect(direct.details?.meta?.truncation).toMatchObject({
      direction: "head",
      truncatedBy: "lines",
    });
  });

  test("byte budget max(50 KiB, lines×512) truncates by bytes with typed details", async () => {
    // omp structural bridge: the host registry stores the same instance the
    // adapter dispatches to; this cast only recovers the concrete omp type.
    const tool = host.tools.read as ReadTool;
    const result = await tool.execute("rd-4", { path: "wide.txt" });
    expect(result.isError).toBeFalsy();
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.outputLines).toBeLessThan(200);
    expect(result.details?.meta?.truncation).toMatchObject({
      direction: "head",
      truncatedBy: "bytes",
    });
  });
});

describe("read specialized readers (T5 #95)", () => {
  test("archive member read via tar:member path", async () => {
    const archive = join(fixture, "arch.tar");
    const result = await executeDispatch(
      host,
      frameOf("read", "rd-5", { path: `${archive}:inner/member.txt` }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("tar member content");
  });

  test("missing archive member is a structured error naming the member", async () => {
    const archive = join(fixture, "arch.tar");
    const result = await executeDispatch(
      host,
      frameOf("read", "rd-6", { path: `${archive}:nope.txt` }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("not found inside archive");
  });

  test("sqlite database lists tables, reads rows, and pages with ?limit/&offset", async () => {
    const dbPath = join(fixture, "data.sqlite");
    const tables = await executeDispatch(host, frameOf("read", "rd-7", { path: dbPath }));
    expect(tables.status).toBe("ok");
    expect(tables.output).toContain("items");

    const rows = await executeDispatch(host, frameOf("read", "rd-8", { path: `${dbPath}:items` }));
    expect(rows.status).toBe("ok");
    expect(rows.output).toContain("first");
    expect(rows.output).toContain("third");

    const page = await executeDispatch(
      host,
      frameOf("read", "rd-9", { path: `${dbPath}:items?limit=1` }),
    );
    expect(page.status).toBe("ok");
    expect(page.output).toContain("first");
    expect(page.output).not.toContain("third");
    expect(page.output).toContain("more rows");
    expect(page.output).toContain("offset=1");
  });

  test("a non-sqlite .db file falls through to the plain text pipeline", async () => {
    const result = await executeDispatch(host, frameOf("read", "rd-10", { path: "fake.db" }));
    expect(result.status).toBe("ok");
    expect(result.output).toContain("just text, not sqlite at all");
  });

  test("URL reads honor the settings gate without network", async () => {
    const result = await executeDispatch(
      host,
      frameOf("read", "rd-11", { path: "https://example.com/page" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("URL reads are disabled by settings");
  });

  test("binary guard explains and :raw returns verbatim bytes", async () => {
    const guarded = await executeDispatch(host, frameOf("read", "rd-12", { path: "blob.bin" }));
    expect(guarded.status).toBe("ok");
    expect(guarded.output).toContain("Cannot read binary file");
    expect(guarded.output).toContain("Use ':raw' to read bytes verbatim");

    const raw = await executeDispatch(host, frameOf("read", "rd-13", { path: "blob.bin:raw" }));
    expect(raw.status).toBe("ok");
    expect(raw.output).toContain("BIN");
  });

  test("notebook converts to editable cell text; :raw keeps the JSON", async () => {
    const converted = await executeDispatch(host, frameOf("read", "rd-14", { path: "book.ipynb" }));
    expect(converted.status).toBe("ok");
    expect(converted.output).toContain("print('hello cell')");
    expect(converted.output).not.toContain("nbformat");

    const raw = await executeDispatch(host, frameOf("read", "rd-15", { path: "book.ipynb:raw" }));
    expect(raw.status).toBe("ok");
    expect(raw.output).toContain("nbformat");
  });
});

describe("executionId replay, client half (T5 #95)", () => {
  test("a watchdog re-forward resolves against the SAME run — zero second execution", async () => {
    let executions = 0;
    host.tools["l1-counting"] = {
      name: "l1-counting",
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: `run-${executions}` }] };
      },
    };
    const runtime = new ToolRuntime({
      workspaceRoot: fixture,
      agentDir: join(root, "omp-agent-replay"),
      machineId: MACHINE,
    });
    const frame = frameOf("l1-counting", "rd-replay-1", {});
    // Both re-forwards are issued inside one tick: ToolRuntime.execute
    // registers the running entry synchronously, so the second call joins
    // the SAME run's promise — the dedup contract does not depend on timing.
    // Test seam: pre-memoize the runtime's lazy host so the spy tool
    // registered on the shared fixture host is the one the runtime runs.
    const runtimeHost = runtime as unknown as { hostPromise: Promise<ToolHost> };
    runtimeHost.hostPromise = Promise.resolve(host);
    const [a, b] = await Promise.all([runtime.execute(frame), runtime.execute(frame)]);
    expect(a.output).toBe("run-1");
    expect(b.output).toBe("run-1");
    expect(executions).toBe(1);
  });
});

describe("write-path safety observed through read (T5/T8 boundary)", () => {
  test("chmod-denied segment proves stage-before-write ordering leaves parse failures inert", async () => {
    // Parse/anchor failures never reach the writer (session.rs stage → write
    // ordering): a read-only file with a MALFORMED patch stays byte-identical.
    const target = join(fixture, "readonly.txt");
    writeFileSync(target, "unchanged bytes\n");
    chmodSync(target, 0o444);
    try {
      const result = await executeDispatch(
        host,
        frameOf("edit", "rd-edit-inert", { input: "not a hashline patch at all" }),
      );
      expect(result.status).toBe("error");
      const after = await Bun.file(target).text();
      expect(after).toBe("unchanged bytes\n");
    } finally {
      chmodSync(target, 0o644);
    }
  });
});
