import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptContent } from "@cap/protocol";
import { decodeAgentAuthConfig } from "../src/client/agent-auth.js";
import { decodeTaskIsolationConfig } from "../src/client/task-isolation.js";
import {
  clientFrameSchema,
  type ClientFrame,
  type ToolExecServiceFrame,
  type ToolExitedFrame,
} from "../src/protocol.js";
import { dispatchToolExec, type ClientRuntime } from "../src/client/connection.js";
import { Executor } from "../src/client/executor.js";
import { stagePromptAttachments } from "../src/client/prompt-attachments.js";
import type { FetchProjectAttachment } from "../src/client/project-attachments.js";
import type {
  ToolDispatchFrame,
  ToolExecutionResult,
  ToolRuntime,
} from "../src/client/tool-runtime.js";

/**
 * L1 attachment staging (#318, real fs — the runtime lane like the per-tool
 * semantic suites): bb prompt-attachments.ts semantics over the #317 prompt
 * content union — staging path shape, sanitize/dedup/0600, byte
 * verification, the attachment_unavailable failure cleanup, and the
 * dispatchToolExec wiring (a tool dispatch carrying the attachment leg has
 * its bytes on disk when the tool runs; a failed pickup answers tool.exited
 * error and leaves nothing behind). The real omp host-tool face is covered
 * by tool-runtime.test.ts and the per-tool suites; the wiring double below
 * isolates THIS ticket's ordering contract.
 */

const MACHINE = "machine-l1-stage";

interface FakeFetcher {
  fetch: FetchProjectAttachment;
  calls: { path: string; projectId: string; threadId: string; maxBytes: number }[];
}

function serving(body: () => Uint8Array, status: "ok" | "fail" = "ok"): FakeFetcher {
  const calls: FakeFetcher["calls"] = [];
  return {
    calls,
    fetch: async (args) => {
      calls.push({
        path: args.path,
        projectId: args.projectId,
        threadId: args.threadId,
        maxBytes: args.maxBytes,
      });
      if (status === "fail") throw new Error("502 upstream gone");
      return { bytes: body() };
    },
  };
}

function stageDirOf(root: string, threadId: string): string {
  return join(root, threadId, "Attachments");
}

const IMAGE_BYTES = new TextEncoder().encode("fake-png-bytes");

describe("stagePromptAttachments (#318)", () => {
  const root = mkdtempSync(join(tmpdir(), "cap-stage-"));
  const threadId = "thr_stage";

  test("stages a relative localImage under <root>/<threadId>/Attachments with 0600", async () => {
    const fetcher = serving(() => IMAGE_BYTES);
    const input: PromptContent[] = [
      { type: "text", text: "look at this" },
      { type: "localImage", path: "9f2c58ab.png" },
    ];
    const staged = await stagePromptAttachments({
      fetchProjectAttachment: fetcher.fetch,
      input,
      projectId: "prj_a",
      threadStorageRootPath: root,
      threadId,
    });
    try {
      const stagedImage = staged.input[1];
      if (stagedImage?.type !== "localImage") throw new Error("expected staged localImage");
      const stagedPath = stagedImage.path;
      expect(stagedPath).toBe(join(stageDirOf(root, threadId), "9f2c58ab.png"));
      expect([...readFileSync(stagedPath)]).toEqual([...IMAGE_BYTES]);
      // bb STAGED_ATTACHMENT_MODE: daemon-private file.
      expect((statSync(stagedPath).mode & 0o777).toString(8)).toBe("600");
      expect(fetcher.calls).toEqual([
        {
          path: "9f2c58ab.png",
          projectId: "prj_a",
          threadId,
          maxBytes: 10 * 1024 * 1024,
        },
      ]);
      // Cleanup (bb cleanupStagedAttachments) removes the file AND the dir.
      await staged.cleanup();
      expect(existsSync(stagedPath)).toBe(false);
      expect(existsSync(stageDirOf(root, threadId))).toBe(false);
    } finally {
      await staged.cleanup().catch(() => undefined);
    }
  });

  test("passes runtime-readable members through and stages nothing", async () => {
    const fetcher = serving(() => IMAGE_BYTES);
    const input: PromptContent[] = [
      { type: "text", text: "plain" },
      { type: "image", url: "https://example.com/x.png" },
      { type: "localImage", path: "/abs/on-host.png" },
      { type: "localFile", path: "file:///data/report.pdf" },
    ];
    const staged = await stagePromptAttachments({
      fetchProjectAttachment: fetcher.fetch,
      input,
      projectId: "prj_a",
      threadStorageRootPath: root,
      threadId,
    });
    expect(staged.input).toEqual(input);
    expect(fetcher.calls).toEqual([]);
    expect(existsSync(stageDirOf(root, threadId))).toBe(false);
    await staged.cleanup();
  });

  test("dedups same filenames with the -2 suffix and sanitizes names", async () => {
    const fileBytes = new TextEncoder().encode("file-bytes");
    const fetcher = serving(() => fileBytes);
    const input: PromptContent[] = [
      {
        type: "localFile",
        path: "aa11.txt",
        name: "my photo (1).txt",
        sizeBytes: fileBytes.byteLength,
      },
      {
        type: "localFile",
        path: "bb22.txt",
        name: "my photo (1).txt",
        sizeBytes: fileBytes.byteLength,
      },
    ];
    const staged = await stagePromptAttachments({
      fetchProjectAttachment: fetcher.fetch,
      input,
      projectId: "prj_a",
      threadStorageRootPath: root,
      threadId,
    });
    try {
      const firstMember = staged.input[0];
      const secondMember = staged.input[1];
      if (firstMember?.type !== "localFile" || secondMember?.type !== "localFile") {
        throw new Error("expected staged localFile members");
      }
      // bb sanitizeFilename + appendFilenameSuffix: sanitized stem, suffix
      // before the extension.
      expect(firstMember.path).toBe(join(stageDirOf(root, threadId), "my-photo-1-.txt"));
      expect(secondMember.path).toBe(join(stageDirOf(root, threadId), "my-photo-1--2.txt"));
      expect(existsSync(firstMember.path)).toBe(true);
      expect(existsSync(secondMember.path)).toBe(true);
    } finally {
      await staged.cleanup();
    }
  });

  test("cleans every staged file when a fetch fails (attachment_unavailable)", async () => {
    const fetcher = serving(() => IMAGE_BYTES, "fail");
    const input: PromptContent[] = [
      { type: "localImage", path: "cc33.png" },
      { type: "localFile", path: "dd44.txt", name: "notes.txt", sizeBytes: 4 },
    ];
    await expect(
      stagePromptAttachments({
        fetchProjectAttachment: fetcher.fetch,
        input,
        projectId: "prj_a",
        threadStorageRootPath: root,
        threadId,
      }),
    ).rejects.toThrow("Failed to fetch attachment cc33.png: 502 upstream gone");
    // The failure path cleaned the staging directory entirely.
    expect(existsSync(stageDirOf(root, threadId))).toBe(false);
  });

  test("enforces the 10MB image limit on fetched bytes", async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const fetcher = serving(() => oversized);
    await expect(
      stagePromptAttachments({
        fetchProjectAttachment: fetcher.fetch,
        input: [{ type: "localImage", path: "ee55.png" }],
        projectId: "prj_a",
        threadStorageRootPath: root,
        threadId,
      }),
    ).rejects.toThrow("Attachment ee55.png exceeds 10485760 byte limit");
    expect(existsSync(stageDirOf(root, threadId))).toBe(false);
  });

  test("verifies localFile declared sizeBytes against fetched bytes", async () => {
    const fetcher = serving(() => IMAGE_BYTES);
    await expect(
      stagePromptAttachments({
        fetchProjectAttachment: fetcher.fetch,
        input: [{ type: "localFile", path: "ff66.txt", name: "a.txt", sizeBytes: 999 }],
        projectId: "prj_a",
        threadStorageRootPath: root,
        threadId,
      }),
    ).rejects.toThrow("Attachment ff66.txt size mismatch: expected 999 bytes, received 14");
  });

  test("refuses an oversized declaration before fetching", async () => {
    const fetcher = serving(() => IMAGE_BYTES);
    await expect(
      stagePromptAttachments({
        fetchProjectAttachment: fetcher.fetch,
        input: [{ type: "localFile", path: "gg77.bin", sizeBytes: 26 * 1024 * 1024 }],
        projectId: "prj_a",
        threadStorageRootPath: root,
        threadId,
      }),
    ).rejects.toThrow("Attachment gg77.bin exceeds 26214400 byte limit");
    // bb validateExpectedAttachmentSize runs BEFORE the pickup.
    expect(fetcher.calls).toEqual([]);
  });

  test("refuses a thread id that escapes the storage root (invalid_path)", async () => {
    const fetcher = serving(() => IMAGE_BYTES);
    await expect(
      stagePromptAttachments({
        fetchProjectAttachment: fetcher.fetch,
        input: [{ type: "localImage", path: "hh88.png" }],
        projectId: "prj_a",
        threadStorageRootPath: root,
        threadId: "../../escape",
      }),
    ).rejects.toThrow("Attachment staging path escapes the thread storage root");
    expect(fetcher.calls).toEqual([]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// dispatchToolExec wiring — the frame leg stages before the tool runs.
// ---------------------------------------------------------------------------

/**
 * Send-capturing socket (host-directory.test.ts idiom) that parses outbound
 * frames with the client schema and resolves a latch on the first frame a
 * test waits for — no polling, the real send is the signal.
 */
class CapturingSocket {
  // dispatchToolExec checks `socket.readyState !== socket.OPEN` before its
  // result send — the real WebSocket constant must exist on the stand-in.
  readonly OPEN = 1 as const;
  readonly readyState = this.OPEN;
  readonly sent: ClientFrame[] = [];
  private readonly latches: { resolve: (frame: ToolExitedFrame) => void }[] = [];

  send(raw: string): void {
    const frame = clientFrameSchema.parse(JSON.parse(raw));
    this.sent.push(frame);
    if (frame.type === "tool.exited") {
      for (const latch of this.latches.splice(0)) latch.resolve(frame);
    }
  }

  /** Resolves with the FIRST frame of `type` sent after this call. */
  once(type: "tool.exited"): Promise<ToolExitedFrame> {
    const { promise, resolve } = Promise.withResolvers<ToolExitedFrame>();
    this.latches.push({ resolve });
    return promise;
  }
}

/**
 * Wiring-double runtime: dispatchToolExec's contract under test is the
 * frame leg → stage → execute ordering, not the omp tool face. The fake
 * proves the ordering by asserting the staged file exists at execute time
 * and reporting its bytes as the result.
 */
class StagedFileRuntime {
  readonly running = new Map<string, Promise<ToolExecutionResult>>();

  execute(
    frame: ToolDispatchFrame,
    _onOutput?: (chunk: string) => void,
  ): Promise<ToolExecutionResult> {
    const path = frame.arguments.path;
    const onDisk = typeof path === "string" && existsSync(path);
    const result: ToolExecutionResult = {
      status: onDisk ? "ok" : "error",
      exitCode: onDisk ? 0 : null,
      output: onDisk
        ? `read ${path}: ${readFileSync(path, "utf8")}`
        : `not staged: ${String(path)}`,
    };
    const { promise, resolve } = Promise.withResolvers<ToolExecutionResult>();
    this.running.set(frame.executionId, promise);
    queueMicrotask(() => resolve(result));
    return promise;
  }
}

function runtimeFor(
  sandboxRoot: string,
  toolRuntime: ToolRuntime,
  fetcher: FetchProjectAttachment,
): ClientRuntime {
  return {
    bootId: "boot_stage",
    executor: new Executor(sandboxRoot),
    machineId: MACHINE,
    toolRuntime,
    buffers: new Map(),
    generation: 0,
    session: null,
    heartbeatTimer: null,
    flushTimer: null,
    connectedAt: Date.now(),
    sessionId: "sess_stage",
    attachmentFetcher: fetcher,
    queue: [],
    queueBusy: false,
  };
}

describe("dispatchToolExec attachment leg (#318)", () => {
  const root = mkdtempSync(join(tmpdir(), "cap-stage-dispatch-"));
  const sandboxRoot = join(root, "sandbox");
  mkdirSync(sandboxRoot, { recursive: true });

  /** Minimal ClientConfig for the dispatch lane (the fetcher is injected).
   * sandboxRoot IS the staging root executeStagedDispatch resolves against. */
  function dispatchConfigOf() {
    return {
      baseUrl: "http://127.0.0.1:9",
      dataDir: join(root, "data"),
      sandboxRoot,
      enrollKey: "",
      joinCode: null,
      taskIsolation: decodeTaskIsolationConfig(undefined),
      agentAuth: decodeAgentAuthConfig(undefined),
    };
  }

  const FILE_TEXT = "attachment-content-on-disk";
  const FILE_BYTES = new TextEncoder().encode(FILE_TEXT);

  function dispatchFrame(fetcher: FakeFetcher): {
    frame: ToolExecServiceFrame;
    runtime: ClientRuntime;
    socket: CapturingSocket;
    socketAsWs: WebSocket;
    stagedPath: string;
  } {
    // Distinct thread per dispatch — the staging dir is per-thread, so the
    // failing test's directory starts (and must stay) empty.
    const threadId = `thr_dispatch_${crypto.randomUUID().slice(0, 8)}`;
    const executionId = `${threadId}:1`;
    const stagedPath = join(stageDirOf(sandboxRoot, threadId), "notes.txt");
    const frame = {
      type: "tool.exec",
      requestId: "req_stage",
      threadId,
      executionId,
      tool: "read",
      arguments: { path: stagedPath },
      timeoutMs: 30_000,
      attachments: {
        projectId: "prj_d",
        items: [
          {
            type: "localFile",
            path: "1234abcd.txt",
            name: "notes.txt",
            sizeBytes: FILE_BYTES.byteLength,
            mimeType: "text/plain",
          },
        ],
      },
    } satisfies ToolExecServiceFrame;
    const socket = new CapturingSocket();
    // CapturingSocket carries the readyState/send surface dispatchToolExec
    // uses; the WebSocket cast only satisfies the DOM parameter type.
    const socketAsWs = socket as unknown as WebSocket;
    const fakeRuntime = new StagedFileRuntime();
    // Same named-const cast posture as the socket above: the dispatch only
    // ever touches running/execute.
    const toolRuntime = fakeRuntime as unknown as ToolRuntime;
    return {
      frame,
      runtime: runtimeFor(sandboxRoot, toolRuntime, fetcher.fetch),
      socket,
      socketAsWs,
      stagedPath,
    };
  }

  test("a dispatch with images finds its attachment on disk when the tool runs", async () => {
    const { frame, runtime, socket, socketAsWs, stagedPath } = dispatchFrame(
      serving(() => FILE_BYTES),
    );
    const exited = socket.once("tool.exited");

    dispatchToolExec(runtime, dispatchConfigOf(), socketAsWs, frame);

    // The spawn_ack left immediately (the serial queue never waits).
    expect(socket.sent.some((frame) => frame.type === "exec.spawn_ack")).toBe(true);
    const result = (await exited).result;
    // The read observed the file content — the bytes were on disk (staged
    // path) when the tool executed.
    expect(result.status).toBe("ok");
    expect(result.output).toContain(FILE_TEXT);
    // Success intentionally keeps the staged file (thread storage outlives
    // the dispatch).
    expect(existsSync(stagedPath)).toBe(true);
  });

  test("a failed pickup answers tool.exited error and runs no tool", async () => {
    const { frame, runtime, socket, socketAsWs, stagedPath } = dispatchFrame(
      serving(() => FILE_BYTES, "fail"),
    );
    const exited = socket.once("tool.exited");

    dispatchToolExec(runtime, dispatchConfigOf(), socketAsWs, frame);

    const result = (await exited).result;
    // bb CommandDispatchError attachment_unavailable as a business error
    // result — upstream message verbatim.
    expect(result.status).toBe("error");
    expect(result.output).toBe("Failed to fetch attachment 1234abcd.txt: 502 upstream gone");
    // No file was left behind and the tool never observed one.
    expect(existsSync(stagedPath)).toBe(false);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});
