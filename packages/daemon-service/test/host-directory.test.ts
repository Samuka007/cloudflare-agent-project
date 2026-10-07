import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostRpcRequestFrame } from "../src/protocol.js";
import { browseHostDirectory } from "../src/client/host-directory.js";
import { dispatchHostRpc, hostRpcUnknownCommandRefusal } from "../src/client/connection.js";

/**
 * #302 bun suite (real fs, like the tool-runtime runtime lane): the daemon
 * face of `host.browse_directory` — verbatim bb browseHostDirectory
 * semantics (apps/host-daemon/src/command-handlers/host-files.ts:130-184) —
 * plus the dispatch glue that wraps it into exactly one host-rpc.response
 * (bb command-router.ts:160-191). dispatchHostRpc resolves when the response
 * frame has been sent, so every glue test awaits the real signal.
 */

let tmpRoot: string;
let tmpReal: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cap-dirbrowse-"));
  tmpReal = await fs.realpath(tmpRoot);
  // A browsable shape: dotfiles and node_modules filtered, mixed-case names,
  // a nested directory, a plain file.
  await fs.mkdir(path.join(tmpReal, "Alpha"));
  await fs.mkdir(path.join(tmpReal, "beta"));
  await fs.mkdir(path.join(tmpReal, "node_modules"));
  await fs.writeFile(path.join(tmpReal, "Alpha", "inner.txt"), "x");
  await fs.writeFile(path.join(tmpReal, ".hidden"), "x");
  await fs.writeFile(path.join(tmpReal, "readme.md"), "x");
  // Symlink faces: target-following classification and a broken link.
  await fs.symlink(path.join(tmpReal, "Alpha"), path.join(tmpReal, "alpha-link"));
  await fs.symlink(path.join(tmpReal, "readme.md"), path.join(tmpReal, "readme-link"));
  await fs.symlink(path.join(tmpReal, "gone"), path.join(tmpReal, "broken-link"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("browseHostDirectory (bb host-files.ts:130-184)", () => {
  test("lists one level: dotfiles/node_modules filtered, symlinks classified, dirs-first case-insensitive order", async () => {
    const listing = await browseHostDirectory({ type: "host.browse_directory", path: tmpRoot });
    expect(listing).toEqual({
      directory: tmpReal,
      parent: path.dirname(tmpReal),
      entries: [
        { kind: "directory", name: "Alpha", path: path.join(tmpReal, "Alpha") },
        { kind: "directory", name: "alpha-link", path: path.join(tmpReal, "alpha-link") },
        { kind: "directory", name: "beta", path: path.join(tmpReal, "beta") },
        { kind: "file", name: "readme-link", path: path.join(tmpReal, "readme-link") },
        { kind: "file", name: "readme.md", path: path.join(tmpReal, "readme.md") },
      ],
    });
  });

  test("a missing path key resolves the host's home directory (bb commands.ts:625-627)", async () => {
    const listing = await browseHostDirectory({ type: "host.browse_directory" });
    // Same-process os.homedir() — the resolved directory follows it, and the
    // listing shape is intact regardless of what the machine's home holds.
    expect(listing.directory).toBe(await fs.realpath(os.homedir()));
    expect(listing.entries).toEqual(expect.any(Array));
  });

  test("the filesystem root answers a null parent", async () => {
    const listing = await browseHostDirectory({ type: "host.browse_directory", path: "/" });
    expect(listing.parent).toBeNull();
  });

  test("a relative path is refused (invalid_path)", async () => {
    await expect(
      browseHostDirectory({ type: "host.browse_directory", path: "relative/dir" }),
    ).rejects.toMatchObject({ name: "HostRpcCommandError", errorCode: "invalid_path" });
  });

  test("a file path and a missing path are invalid_path refusals", async () => {
    await expect(
      browseHostDirectory({ type: "host.browse_directory", path: path.join(tmpReal, "readme.md") }),
    ).rejects.toMatchObject({ errorCode: "invalid_path" });
    await expect(
      browseHostDirectory({
        type: "host.browse_directory",
        path: path.join(tmpReal, "gone"),
      }),
    ).rejects.toMatchObject({
      name: "HostRpcCommandError",
      errorCode: "invalid_path",
      message: expect.stringContaining("does not exist"),
    });
  });
});

/** Send-capturing socket stand-in (FakeSocket idiom, l1-ws-close-reconnect). */
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

describe("dispatchHostRpc (bb command-router.ts:160-191)", () => {
  test("a browse answers one ok response carrying the listing", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc({ sandboxRoot: tmpReal, dataDir: tmpReal }, socket as unknown as WebSocket, rpcFrame({ type: "host.browse_directory", path: tmpRoot }, "req-1"));
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-1",
        commandType: "host.browse_directory",
        ok: true,
        result: { directory: tmpReal, parent: path.dirname(tmpReal), entries: expect.any(Array) },
      },
    ]);
  });

  test("a browse failure answers ok:false with the dispatch error code", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc({ sandboxRoot: tmpReal, dataDir: tmpReal }, socket as unknown as WebSocket, rpcFrame({ type: "host.browse_directory", path: path.join(tmpReal, "readme.md") }, "req-2"));
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-2",
        commandType: "host.browse_directory",
        ok: false,
        errorCode: "invalid_path",
        errorMessage: `Path "${path.join(tmpReal, "readme.md")}" is not a directory`,
      },
    ]);
  });

  test("a version-skew host-rpc command is refused at the parse gate, never silenced", async () => {
    // bb server-connection.ts:609-613: an unparseable host-rpc request gets
    // an explicit failure response so the caller's waiter does not burn its
    // timeout. The refusal lives in the pump (handleServiceFrame), not the
    // dispatcher — an unknown command never reaches dispatchHostRpc.
    expect(hostRpcUnknownCommandRefusal(rpcFrame({ type: "host.pick_folder" }, "req-3"))).toEqual({
      type: "host-rpc.response",
      requestId: "req-3",
      commandType: "host.pick_folder",
      ok: false,
      errorCode: "unknown_command",
      errorMessage: "This daemon does not implement host.pick_folder",
    });
    expect(hostRpcUnknownCommandRefusal({ type: "heartbeat" })).toBeNull();
  });
});
