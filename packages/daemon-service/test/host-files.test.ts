import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostRpcRequestFrame } from "../src/protocol.js";
import { readHostFile } from "../src/client/host-files.js";
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
