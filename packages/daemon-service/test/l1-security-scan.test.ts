import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertNativeAddonCurrent,
  createToolHost,
  executeDispatch,
  readNativeAddonStatus,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";

/**
 * L1 for the security_scan host-face disablement (#522, user ruling
 * 2026-10-08): the daemon no longer pins `security.enabled`, so omp's own
 * default-off gate keeps the tool out of the map — every fresh host builds
 * without security_scan, and a dispatch degrades to "unknown tool". The
 * #523 follow-up removed the last DAEMON_AGENT_AUTH consumer (find's judge
 * leg moved to the edge), so the whole channel is gone: no auth-shaped
 * config reaches the host at all.
 *
 * The former end-to-end L1 (native preflight fingerprint, background
 * coordinator cancel, credential-on-host seams — T15 #105/#221) tested the
 * now-disabled face; it was deleted with it. omp's own gate semantics stay
 * omp's test suite — the daemon surface under test here is exactly
 * "gate closed = tool absent".
 *
 * omp module imports stay DYNAMIC in this file (exception to the static
 * import rule): omp ships raw TS over the native addon — static specifiers
 * would evaluate the omp module graph before beforeAll's addon-version gate
 * can refuse a stale addon (the tool-runtime.ts constraint, restated per
 * test file; same pattern as tool-runtime.test.ts).
 */

const MACHINE = "machine-l1-security";

let root: string;
let host: ToolHost;
let bareHost: ToolHost;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-security-l1-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  mkdirSync(join(root, "workspace-b"), { recursive: true });
  assertNativeAddonCurrent(await readNativeAddonStatus());
  // #523: no agentAuth leg exists any more — both twins build bare.
  host = await createToolHost(join(root, "workspace"), join(root, "omp-agent-sec"), MACHINE);
  bareHost = await createToolHost(join(root, "workspace-b"), join(root, "omp-agent-bare"), MACHINE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#522 — security_scan host face disabled (gate closed = tool absent)", () => {
  test("the tool map has no security_scan on either host", () => {
    expect(host.tools.security_scan).toBeUndefined();
    expect(bareHost.tools.security_scan).toBeUndefined();
    // Canary: the rest of the host face is intact — the gate closed ONLY
    // for security_scan.
    for (const name of ["read", "glob", "grep", "find", "write", "edit"]) {
      expect(host.tools[name]?.name).toBe(name);
    }
  });

  test("a security_scan dispatch degrades to unknown tool on the host face", async () => {
    const result = await executeDispatch(
      host,
      frameOf("security_scan", "sec-1", {
        action: "preflight",
        target_kind: "repository",
      }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("unknown tool: security_scan");
  });
});
