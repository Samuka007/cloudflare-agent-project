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
import { decodeAgentAuthConfig } from "../src/client/agent-auth.js";

/**
 * L1 for the security_scan host-face disablement (#522, user ruling
 * 2026-10-08): the daemon no longer pins `security.enabled`, so omp's own
 * default-off gate keeps the tool out of the map — every fresh host builds
 * without security_scan, and a dispatch degrades to "unknown tool". The
 * config leg is gone with it: `securityModel` is no longer part of
 * DAEMON_AGENT_AUTH, and a stale env value is stripped by the schema (zod
 * default), not rejected.
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
  root = mkdtempSync(join(tmpdir(), "omp-security-gate-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  mkdirSync(join(root, "workspace-b"), { recursive: true });
  // The version gate is the refuse-start precondition (tool-runtime.test.ts)
  // — it runs before ANY omp module graph evaluates.
  assertNativeAddonCurrent(await readNativeAddonStatus());
  // The agentAuth twin keeps a live judge leg to prove the disablement is
  // scoped to the security face, not an auth-shape change.
  const authConfig = decodeAgentAuthConfig(JSON.stringify({ judgeRole: "secprov/judge-model" }));
  host = await createToolHost(
    join(root, "workspace"),
    join(root, "omp-agent-sec"),
    MACHINE,
    authConfig,
  );
  // The bare twin: no agentAuth at all — the gate is closed either way.
  bareHost = await createToolHost(join(root, "workspace-b"), join(root, "omp-agent-bare"), MACHINE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#522 — security_scan host face disabled (gate closed = tool absent)", () => {
  test("omp's own enablement gate reads default-off on the host settings", async () => {
    const { cfgSecurityEnabled } = await import("@oh-my-pi/pi-coding-agent/tools/settings");
    expect(cfgSecurityEnabled.get(host.settings)).toBe(false);
    expect(cfgSecurityEnabled.get(bareHost.settings)).toBe(false);
  });

  test("the tool map has no security_scan — with or without agentAuth", () => {
    expect(host.tools.security_scan).toBeUndefined();
    expect(bareHost.tools.security_scan).toBeUndefined();
    // Canary: the rest of the host face is intact — the gate closed ONLY
    // security_scan (enablement gate rides manage_skill on the same map).
    expect(host.tools.read).toBeDefined();
    expect(host.tools.manage_skill).toBeDefined();
  });

  test("a security_scan dispatch degrades to unknown tool through the frame", async () => {
    const result = await executeDispatch(
      host,
      frameOf("security_scan", "sec-gate-1", { action: "preflight" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toBe("unknown tool: security_scan");
  });

  test("the securityModel config leg is gone: the schema strips a stale env value", () => {
    const config = decodeAgentAuthConfig(
      JSON.stringify({ securityModel: "secprov/sec-model", judgeRole: "secprov/judge-model" }),
    );
    expect("securityModel" in config).toBe(false);
    expect(config.judgeRole).toBe("secprov/judge-model");
  });
});
