import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostRpcRequestFrame } from "../src/protocol.js";
import { mkdirHostPath } from "../src/client/host-path-mutations.js";
import { dispatchHostRpc } from "../src/client/connection.js";
import { HostRpcCommandError } from "../src/client/host-directory.js";

/**
 * #494 bun suite (real fs, host-directory.test.ts lane): the daemon face of
 * `host.mkdir` — verbatim bb mkdirHostPath + containment semantics
 * (apps/host-daemon/src/command-handlers/path-mutations.ts:78-92,
 * root-path.ts:9-27, file-write.ts:46-106) — plus the dispatch glue that
 * wraps it into exactly one host-rpc.response (bb command-router.ts:160-191).
 */

let tmpRoot: string;
let tmpReal: string;
let outsideRoot: string;
let outsideReal: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cap-mkdir-"));
  tmpReal = await fs.realpath(tmpRoot);
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cap-mkdir-out-"));
  outsideReal = await fs.realpath(outsideRoot);
  await fs.mkdir(path.join(tmpReal, "existing"));
  await fs.writeFile(path.join(tmpReal, "plain.txt"), "x");
  // A symlink to a directory inside the root (follows legitimately) and one
  // to a directory outside it (the smuggling vector containment must catch).
  await fs.symlink(path.join(tmpReal, "existing"), path.join(tmpReal, "root-link"));
  await fs.symlink(outsideReal, path.join(tmpReal, "escape-link"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
});

/** The stable dispatch code a rejection carries: a command-level refusal
 * (HostRpcCommandError.errorCode) or a raw fs error (Node code) — exactly
 * what dispatchHostRpc's failure mapping forwards. */
async function rejectionCode(
  run: () => Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HostRpcCommandError) {
      return { code: error.errorCode, message: error.message };
    }
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return { code, message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error("expected the operation to reject");
}

describe("mkdirHostPath (bb path-mutations.ts:78-92)", () => {
  test("creates one directory under the declared root", async () => {
    const result = await mkdirHostPath({
      type: "host.mkdir",
      path: path.join(tmpReal, "created"),
      rootPath: tmpReal,
      recursive: false,
    });
    expect(result).toEqual({ ok: true });
    expect((await fs.stat(path.join(tmpReal, "created"))).isDirectory()).toBe(true);
  });

  test("recursive:true creates the missing parent chain", async () => {
    const result = await mkdirHostPath({
      type: "host.mkdir",
      path: path.join(tmpReal, "a", "b", "c"),
      rootPath: tmpReal,
      recursive: true,
    });
    expect(result).toEqual({ ok: true });
    expect((await fs.stat(path.join(tmpReal, "a", "b", "c"))).isDirectory()).toBe(true);
  });

  test("recursive:false with a missing parent answers the fs ENOENT", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "gone", "inner"),
        rootPath: tmpReal,
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("ENOENT");
  });

  test("an existing directory answers EEXIST without recursive", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "existing"),
        rootPath: tmpReal,
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("EEXIST");
  });

  test("an existing directory is a no-op with recursive:true", async () => {
    const result = await mkdirHostPath({
      type: "host.mkdir",
      path: path.join(tmpReal, "existing"),
      rootPath: tmpReal,
      recursive: true,
    });
    expect(result).toEqual({ ok: true });
  });

  test("a relative path is refused as invalid_path", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({ type: "host.mkdir", path: "relative/dir", recursive: false }),
    );
    expect(rejection.code).toBe("invalid_path");
    expect(rejection.message).toBe("Path must be absolute");
  });

  test("a relative rootPath is refused as invalid_path", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "x"),
        rootPath: "relative-root",
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("invalid_path");
    expect(rejection.message).toBe("rootPath must be absolute");
  });

  test("a path outside the declared root escapes as invalid_path", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(outsideReal, "created"),
        rootPath: tmpReal,
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("invalid_path");
    expect(rejection.message).toContain("escapes root");
  });

  test("a path through a symlinked directory inside the root escapes as invalid_path", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "escape-link", "created"),
        rootPath: tmpReal,
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("invalid_path");
    expect(rejection.message).toContain("escapes root");
  });

  test("a symlinked directory inside the root is followed and stays contained", async () => {
    const result = await mkdirHostPath({
      type: "host.mkdir",
      path: path.join(tmpReal, "root-link", "inner"),
      rootPath: tmpReal,
      recursive: false,
    });
    expect(result).toEqual({ ok: true });
    expect((await fs.stat(path.join(tmpReal, "existing", "inner"))).isDirectory()).toBe(true);
  });

  test("a symlinked rootPath is refused (containment would be meaningless)", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "existing", "via-link"),
        rootPath: path.join(tmpReal, "root-link"),
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("invalid_path");
    expect(rejection.message).toContain("must not be a symlink");
  });

  test("a non-directory rootPath is refused", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "x"),
        rootPath: path.join(tmpReal, "plain.txt"),
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("invalid_path");
    expect(rejection.message).toContain("is not a directory");
  });

  test("a missing rootPath answers the fs ENOENT", async () => {
    const rejection = await rejectionCode(() =>
      mkdirHostPath({
        type: "host.mkdir",
        path: path.join(tmpReal, "x"),
        rootPath: path.join(tmpReal, "no-such-root"),
        recursive: false,
      }),
    );
    expect(rejection.code).toBe("ENOENT");
  });

  test("no rootPath: the explicit absolute path is used as-is", async () => {
    const result = await mkdirHostPath({
      type: "host.mkdir",
      path: path.join(outsideReal, "free"),
      recursive: false,
    });
    expect(result).toEqual({ ok: true });
    expect((await fs.stat(path.join(outsideReal, "free"))).isDirectory()).toBe(true);
  });
});

/** Send-capturing socket stand-in (host-files.test.ts idiom). */
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

describe("dispatchHostRpc mkdir glue (bb command-router.ts:160-191)", () => {
  test("mkdir answers one ok response carrying the mutation result", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      { sandboxRoot: tmpReal, dataDir: tmpReal },
      socket as unknown as WebSocket,
      rpcFrame(
        {
          type: "host.mkdir",
          path: path.join(tmpReal, "glue-ok"),
          rootPath: tmpReal,
          recursive: false,
        },
        "req-mkdir-ok",
      ),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-mkdir-ok",
        commandType: "host.mkdir",
        ok: true,
        result: { ok: true },
      },
    ]);
    expect((await fs.stat(path.join(tmpReal, "glue-ok"))).isDirectory()).toBe(true);
  });

  test("a refused mkdir answers one failure carrying the dispatch code", async () => {
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      { sandboxRoot: tmpReal, dataDir: tmpReal },
      socket as unknown as WebSocket,
      rpcFrame({ type: "host.mkdir", path: "relative", recursive: false }, "req-mkdir-fail"),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-mkdir-fail",
        commandType: "host.mkdir",
        ok: false,
        errorCode: "invalid_path",
        errorMessage: "Path must be absolute",
      },
    ]);
  });
});
