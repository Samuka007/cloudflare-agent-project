import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { promisify } from "node:util";

import type { HostRpcRequestFrame } from "../src/protocol.js";
import {
  checkHostPathsExist,
  cloneProject,
  inspectProjectPath,
  resolveProjectCloneDefaultPath,
} from "../src/client/project.js";
import { dispatchHostRpc } from "../src/client/connection.js";

/**
 * #445 runtime suite (real fs + real git, the host-directory.test.ts lane):
 * the daemon face of the add-source project commands — verbatim port of bb's
 * command-handlers/project.test.ts (clone happy path, structured
 * target_not_empty, git stderr preservation, checkout-convention derivation)
 * plus the `host.paths_exist` probe (bb host-files.ts:186-193) and the
 * dispatchHostRpc glue for all four commands (one host-rpc.response each).
 */

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cap-project-clone-"));
  tempDirs.push(dir);
  return dir;
}

async function run(args: string[], cwd: string): Promise<void> {
  await promisify(execFile)("git", args, { cwd, encoding: "utf8" });
}

async function createRemoteRepo(root: string): Promise<string> {
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(source, { recursive: true });
  await run(["init"], source);
  await fs.writeFile(path.join(source, "README.md"), "hello\n");
  await run(["add", "README.md"], source);
  await run(
    ["-c", "user.name=Cap Test", "-c", "user.email=cap@example.test", "commit", "-m", "initial"],
    source,
  );
  await run(["clone", "--bare", source, remote], root);
  return remote;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("cloneProject (bb command-handlers/project.ts:62-86)", () => {
  test("clones a real repository and reports the resolved path and origin", async () => {
    const root = await tempDir();
    const remoteUrl = await createRemoteRepo(root);
    const result = await cloneProject(
      { type: "project.clone", remoteUrl, projectSlug: "My Project" },
      path.join(root, "data"),
    );

    expect(result).toEqual({
      path: path.join(root, "data", "checkouts", "my-project"),
      gitRemoteUrl: remoteUrl,
    });
    await expect(fs.readFile(path.join(result.path, "README.md"), "utf8")).resolves.toBe("hello\n");
  });

  test("refuses a non-empty target with a structured error", async () => {
    const root = await tempDir();
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    await fs.writeFile(path.join(targetPath, "keep.txt"), "keep");

    await expect(
      cloneProject(
        {
          type: "project.clone",
          remoteUrl: path.join(root, "remote.git"),
          projectSlug: "project",
          targetPath,
        },
        path.join(root, "data"),
      ),
    ).rejects.toMatchObject({
      name: "HostRpcCommandError",
      errorCode: "target_not_empty",
      message: `Clone target is not empty: ${targetPath}`,
    });
  });

  test("preserves git stderr in a structured clone failure", async () => {
    const root = await tempDir();
    const missingRemote = path.join(root, "missing.git");

    await expect(
      cloneProject(
        { type: "project.clone", remoteUrl: missingRemote, projectSlug: "project" },
        path.join(root, "data"),
      ),
    ).rejects.toMatchObject({
      errorCode: "git_command_failed",
    });
    await expect(
      cloneProject(
        { type: "project.clone", remoteUrl: missingRemote, projectSlug: "project" },
        path.join(root, "data"),
      ),
    ).rejects.toThrow(/does not exist/u);
  });

  test("derives the checkout convention without touching the filesystem", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    expect(resolveProjectCloneDefaultPath(dataDir, " Project / Name ")).toEqual({
      path: path.join(dataDir, "checkouts", "project-name"),
    });
    await expect(fs.stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("inspectProjectPath (bb command-handlers/project.ts:46-60)", () => {
  test("reports the origin remote of a git checkout and null for a plain directory", async () => {
    const root = await tempDir();
    const remoteUrl = await createRemoteRepo(root);
    const checkout = path.join(root, "checkout");
    await run(["clone", remoteUrl, checkout], root);

    await expect(inspectProjectPath({ type: "project.inspect", path: checkout })).resolves.toEqual({
      path: await fs.realpath(checkout),
      gitRemoteUrl: remoteUrl,
    });
    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    await expect(inspectProjectPath({ type: "project.inspect", path: plain })).resolves.toEqual({
      path: path.resolve(plain),
      gitRemoteUrl: null,
    });
  });
});

describe("checkHostPathsExist (bb command-handlers/host-files.ts:186-193)", () => {
  test("maps every asked path to its existence, missing entries included", async () => {
    const root = await tempDir();
    const present = path.join(root, "present");
    await fs.mkdir(present);

    await expect(
      checkHostPathsExist({ paths: [present, path.join(root, "gone")] }),
    ).resolves.toEqual({
      existence: { [present]: true, [path.join(root, "gone")]: false },
    });
  });
});

/** Send-capturing socket stand-in (FakeSocket idiom, host-directory.test.ts). */
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

describe("dispatchHostRpc glue for the add-source commands", () => {
  test("clone_default_path answers the convention path; paths_exist answers the map", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      { sandboxRoot: root, dataDir },
      socket as unknown as WebSocket,
      rpcFrame({ type: "project.clone_default_path", projectSlug: "My Project" }, "req-p1"),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-p1",
        commandType: "project.clone_default_path",
        ok: true,
        result: { path: path.join(dataDir, "checkouts", "my-project") },
      },
    ]);

    const present = path.join(root, "present");
    await fs.mkdir(present);
    const probeSocket = new CapturingSocket();
    await dispatchHostRpc(
      { sandboxRoot: root, dataDir },
      probeSocket as unknown as WebSocket,
      rpcFrame({ type: "host.paths_exist", paths: [present] }, "req-p2"),
    );
    expect(probeSocket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-p2",
        commandType: "host.paths_exist",
        ok: true,
        result: { existence: { [present]: true } },
      },
    ]);
  });

  test("a failing clone answers ok:false with the dispatch error code", async () => {
    const root = await tempDir();
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    await fs.writeFile(path.join(targetPath, "keep.txt"), "keep");
    const socket = new CapturingSocket();
    await dispatchHostRpc(
      { sandboxRoot: root, dataDir: path.join(root, "data") },
      socket as unknown as WebSocket,
      rpcFrame(
        {
          type: "project.clone",
          remoteUrl: path.join(root, "remote.git"),
          projectSlug: "project",
          targetPath,
        },
        "req-p3",
      ),
    );
    expect(socket.sent).toEqual([
      {
        type: "host-rpc.response",
        requestId: "req-p3",
        commandType: "project.clone",
        ok: false,
        errorCode: "target_not_empty",
        errorMessage: `Clone target is not empty: ${targetPath}`,
      },
    ]);
  });
});
