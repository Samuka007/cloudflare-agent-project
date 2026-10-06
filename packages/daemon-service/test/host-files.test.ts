import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostRpcRequestFrame } from "../src/protocol.js";
import { readHostFile, writeThreadFile } from "../src/client/host-files.js";
import { dispatchHostRpc } from "../src/client/connection.js";

/**
 * B1 (#321) bun suite (real fs, host-directory.test.ts lane): the daemon face
 * of `host.read_file` — the rootless subset of bb readHostFile +
 * readFileForTransport (apps/host-daemon/src/command-handlers/file-read.ts:
 * 302-341) behind the thread host-file content face. dispatchHostRpc glue
 * mirrors host-directory.test.ts: one ok/failure response, awaitable.
 */

let tmpRoot: string;
let tmpReal: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cap-hostfile-"));
  tmpReal = await fs.realpath(tmpRoot);
  await fs.writeFile(path.join(tmpReal, "notes.txt"), "host notes", "utf8");
  await fs.writeFile(path.join(tmpReal, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
  // Invalid UTF-8 (0xFF is never valid) → base64 branch.
  await fs.writeFile(path.join(tmpReal, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x01]));
  await fs.mkdir(path.join(tmpReal, "dir.d"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function sha256Hex(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("readHostFile (bb file-read.ts:302-341 rootless)", () => {
  test("utf-8 text reads as utf8 with mime, stat terms, and a byte sha256", async () => {
    const filePath = path.join(tmpReal, "notes.txt");
    const result = await readHostFile({ type: "host.read_file", path: filePath });
    expect(result).toEqual({
      path: filePath,
      content: "host notes",
      contentEncoding: "utf8",
      mimeType: "text/plain; charset=utf-8",
      modifiedAtMs: expect.any(Number),
      sha256: sha256Hex(Buffer.from("host notes", "utf8")),
      sizeBytes: 10,
    });
  });

  test("binary image reads as base64 and 0xff bytes fall off the utf8 branch", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const png = await readHostFile({ type: "host.read_file", path: path.join(tmpReal, "pic.png") });
    expect(png.contentEncoding).toBe("base64");
    expect(png.mimeType).toBe("image/png");
    expect(png.content).toBe(pngBytes.toString("base64"));
    expect(png.sha256).toBe(sha256Hex(pngBytes));

    const blob = await readHostFile({ type: "host.read_file", path: path.join(tmpReal, "blob.bin") });
    expect(blob.contentEncoding).toBe("base64");
    expect(blob.content).toBe(Buffer.from([0x00, 0xff, 0xfe, 0x01]).toString("base64"));
  });

  test("unknown extensions have no mime (octet-stream downstream)", async () => {
    const weird = path.join(tmpReal, "data.weird");
    await fs.writeFile(weird, "ok");
    const result = await readHostFile({ type: "host.read_file", path: weird });
    expect(result.mimeType).toBeUndefined();
  });

  test("a relative path, a directory, and a missing path are stable refusals", async () => {
    await expect(
      readHostFile({ type: "host.read_file", path: "relative/file.txt" }),
    ).rejects.toMatchObject({ name: "HostRpcCommandError", errorCode: "invalid_path" });
    await expect(
      readHostFile({ type: "host.read_file", path: path.join(tmpReal, "dir.d") }),
    ).rejects.toMatchObject({ errorCode: "invalid_path", message: "Path is a directory, not a file" });
    await expect(
      readHostFile({ type: "host.read_file", path: path.join(tmpReal, "gone.txt") }),
    ).rejects.toMatchObject({ errorCode: "ENOENT", message: expect.stringContaining("does not exist") });
  });

  test("the image/non-image caps hold (bb 10MB/25MB, file-read.ts:15-16)", async () => {
    const bigPng = path.join(tmpReal, "big.png");
    const bigTxt = path.join(tmpReal, "big.txt");
    await fs.writeFile(bigPng, Buffer.alloc(10 * 1024 * 1024 + 1, 0x89));
    await fs.writeFile(bigTxt, Buffer.alloc(25 * 1024 * 1024 + 1, 0x61));
    await expect(
      readHostFile({ type: "host.read_file", path: bigPng }),
    ).rejects.toMatchObject({ errorCode: "file_too_large", message: expect.stringContaining("10 MB") });
    await expect(
      readHostFile({ type: "host.read_file", path: bigTxt }),
    ).rejects.toMatchObject({ errorCode: "file_too_large", message: expect.stringContaining("25 MB") });
  });
});

/** Send-capturing socket stand-in (host-directory.test.ts idiom). */
class CapturingSocket {
  readonly sent: Record<string, unknown>[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
}

function rpcFrame(command: unknown, requestId: string): HostRpcRequestFrame {
  return {
    type: "host-rpc.request",
    requestId,
    command,
  } as HostRpcRequestFrame;
}

describe("dispatchHostRpc read_file glue (bb command-router.ts:160-191)", () => {
  test("a read answers one ok response carrying the file result", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      tmpReal,
      socket as unknown as WebSocket,
      rpcFrame({ type: "host.read_file", path: path.join(tmpReal, "notes.txt") }, "req-b1"),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-b1",
        commandType: "host.read_file",
        ok: true,
        result: expect.objectContaining({ path: path.join(tmpReal, "notes.txt"), contentEncoding: "utf8" }),
      },
    ]);
  });

  test("a failed read answers one failure carrying the dispatch code", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      tmpReal,
      socket as unknown as WebSocket,
      rpcFrame({ type: "host.read_file", path: path.join(tmpReal, "gone.txt") }, "req-b2"),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-b2",
        commandType: "host.read_file",
        ok: false,
        errorCode: "ENOENT",
        errorMessage: expect.stringContaining("does not exist"),
      },
    ]);
  });
});

describe("writeThreadFile (B2 #322 thread file write)", () => {
  test("lands the decoded bytes under <sandbox>/<threadId>/Generated at 0600 and answers the absolute path", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await writeThreadFile(
      { type: "host.write_file", threadId: "thr-1", filename: "agent-image-1.png", contentBase64: bytes.toString("base64") },
      tmpRoot,
    );
    const expectedDir = path.join(tmpReal, "thr-1", "Generated");
    expect(result).toEqual({ path: path.join(expectedDir, "agent-image-1.png"), sizeBytes: bytes.length });
    const written = await fs.stat(result.path);
    expect(written.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(result.path)).toEqual(bytes);
  });

  test("a filename collision dedups with a -2 suffix instead of overwriting", async () => {
    const first = await writeThreadFile(
      { type: "host.write_file", threadId: "thr-dedup", filename: "pic.png", contentBase64: Buffer.from("one").toString("base64") },
      tmpRoot,
    );
    const second = await writeThreadFile(
      { type: "host.write_file", threadId: "thr-dedup", filename: "pic.png", contentBase64: Buffer.from("two").toString("base64") },
      tmpRoot,
    );
    expect(path.basename(first.path)).toBe("pic.png");
    expect(path.basename(second.path)).toBe("pic-2.png");
    expect(await fs.readFile(second.path, "utf8")).toBe("two");
    expect(await fs.readFile(first.path, "utf8")).toBe("one");
  });

  test("a separator-smuggling or escaping threadId is refused, never written outside the root", async () => {
    await expect(
      writeThreadFile(
        { type: "host.write_file", threadId: "../escape", filename: "x.png", contentBase64: "aGk=" },
        tmpRoot,
      ),
    ).rejects.toMatchObject({
      errorCode: "invalid_path",
      message: expect.stringContaining("single path segment"),
    });
    await expect(
      writeThreadFile(
        { type: "host.write_file", threadId: "a/b", filename: "x.png", contentBase64: "aGk=" },
        tmpRoot,
      ),
    ).rejects.toMatchObject({ errorCode: "invalid_path" });
    await expect(fs.access(path.join(tmpReal, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("filename sanitation strips separators and hostile runs; empty sanitizes to the fallback", async () => {
    const smuggle = await writeThreadFile(
      { type: "host.write_file", threadId: "thr-s", filename: "../../etc/passwd", contentBase64: Buffer.from("x").toString("base64") },
      tmpRoot,
    );
    expect(smuggle.path.startsWith(path.join(tmpReal, "thr-s", "Generated"))).toBe(true);
    expect(path.basename(smuggle.path)).toBe("passwd");

    const dots = await writeThreadFile(
      { type: "host.write_file", threadId: "thr-s", filename: "..", contentBase64: Buffer.from("x").toString("base64") },
      tmpRoot,
    );
    expect(path.basename(dots.path)).toBe("generated-image");
  });

  test("an oversize payload refuses at the write with the read face's code", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x89);
    await expect(
      writeThreadFile(
        { type: "host.write_file", threadId: "thr-big", filename: "big.png", contentBase64: big.toString("base64") },
        tmpRoot,
      ),
    ).rejects.toMatchObject({ errorCode: "file_too_large", message: expect.stringContaining("10 MB") });
  });

  test("malformed base64 refuses instead of writing truncated bytes", async () => {
    await expect(
      writeThreadFile(
        { type: "host.write_file", threadId: "thr-b64", filename: "x.png", contentBase64: "@@@@" },
        tmpRoot,
      ),
    ).rejects.toMatchObject({ errorCode: "invalid_path", message: expect.stringContaining("malformed base64") });
  });

  test("the command rides the live socket and the write result resolves the caller", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      tmpReal,
      socket as unknown as WebSocket,
      rpcFrame(
        { type: "host.write_file", threadId: "thr-glue", filename: "glue.png", contentBase64: Buffer.from("glue").toString("base64") },
        "req-w1",
      ),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-w1",
        commandType: "host.write_file",
        ok: true,
        result: expect.objectContaining({ path: expect.stringContaining(path.join("thr-glue", "Generated")), sizeBytes: 4 }),
      },
    ]);
  });
});
