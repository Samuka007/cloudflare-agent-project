import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
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
 * L1 for security_scan through the embedded omp runtime (M1.5/T15 #105) —
 * runs under Bun (the daemon host runtime). The tool is 整体归 daemon: both
 * halves execute on the host behind the tool-agnostic frame.
 *
 * Acceptance mapping (proposal §3 T15):
 * - native preflight fingerprint assertions: the plan tree digest moves on
 *   content / executable-bit / symlink / HEAD changes and is deterministic
 *   for an unchanged tree (omp-security-tree/v1:sha256, preflight.ts
 *   digestWorkingTree).
 * - background cancel: the host-side coordinator flips an in-flight
 *   operation to `cancelled` (stub scan session; the real session factory
 *   needs a live model — the cancel semantics under test are the
 *   coordinator's, which the tool delegates to verbatim).
 * - credential-stays-on-host seam: cloud actions resolve the bearer token
 *   from the daemon-private authStorage at request time on the host; an
 *   unpinned model / missing account fail closed before any network; no
 *   credential material appears in dispatch frames or results.
 *
 * omp module imports stay DYNAMIC in this file (exception to the static
 * import rule): omp ships raw TS over the native addon — static specifiers
 * would evaluate the omp module graph before beforeAll's addon-version gate
 * can refuse a stale addon (the tool-runtime.ts constraint, restated per
 * test file; same pattern as tool-runtime.test.ts).
 */

const MACHINE = "machine-l1-security";
// The host-stored ChatGPT credential's ACCESS token — a JWT, because
// cloud_start decodes its sub host-side into the scan input (jwtSubject).
const HOST_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "sec-user-77", email: "sec@example.test" })).toString(
    "base64url",
  ),
  Buffer.from("sig").toString("base64url"),
].join(".");
const HOST_ACCOUNT_ID = "acct-sec-77";

/** omp's SecurityScanBundle read back from the host store (outside-written
 * JSON → schema parse at this boundary). */
const CancelledBundle = z.object({ scan: z.object({ status: z.string() }) });

/** omp's persisted security plan (outside-written JSON → schema parse). */
const SecurityPlan = z.object({
  fingerprint: z.string(),
  target: z.object({ treeDigest: z.string() }),
  model: z.object({ provider: z.string(), modelId: z.string() }),
  account: z.object({ credentialId: z.number(), provider: z.string() }),
});

/** The Codex Security cloud scan_input POST body the host client builds. */
const CloudStartBody = z.object({
  scan_input: z.object({
    owner_id: z.string(),
    repo_id: z.string(),
    state: z.string(),
  }),
});

// omp surface bridge: ToolHost.session is deliberately `Record<string,
// unknown>` (the structural seam in tool-runtime.ts); these members are omp's
// own public APIs, read once here. Unchecked cast with reason: the host
// constructs this exact shape (tool-runtime.ts sessionBase).
interface HostSessionSurface {
  authStorage: {
    credentials: {
      upsert(provider: string, credential: Record<string, unknown>): Promise<unknown>;
    };
  };
  modelRegistry: unknown;
  getActiveModel?: () => unknown;
}

let root: string;
let repo: string;
let repoB: string;
let agentDir: string;
let host: ToolHost;
let bareHost: ToolHost;
let hostSession: HostSessionSurface;
let secprovCredentialId: number;
let codexCredentialId: number;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

function git(args: string, cwd: string = repo): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

/** The deterministic leg: target.treeDigest (omp-security-tree/v1:sha256).
 * plan.fingerprint additionally pins the output root (a fresh uuid per
 * preflight), so determinism asserts on the tree digest, not the plan. */
async function preflightFingerprint(
  executionId: string,
): Promise<{ treeDigest: string; planId: string }> {
  const result = await executeDispatch(
    host,
    frameOf("security_scan", executionId, { action: "preflight" }),
  );
  if (result.status !== "ok") throw new Error(`preflight failed: ${result.output}`);
  // plan.fingerprint pins the plan material (tree digest + model + account +
  // config + workflow); target.treeDigest is the omp-security-tree inner leg.
  const fingerprint = /Fingerprint: (omp-security-plan\/v1:sha256:[0-9a-f]{64})\./.exec(
    result.output,
  )?.[1];
  const planId = /plan_id=(secplan_[a-z0-9]+)/.exec(result.output)?.[1];
  if (fingerprint === undefined || planId === undefined) {
    throw new Error(`preflight output did not pin fingerprint/plan: ${result.output}`);
  }
  const store = await openHostSecurityStore();
  const plan = SecurityPlan.parse(
    JSON.parse(readFileSync(join(store.projectDirectory, "plans", `${planId}.json`), "utf8")),
  );
  if (plan.fingerprint !== fingerprint)
    throw new Error("plan-file fingerprint disagrees with the dispatch text");
  return { treeDigest: plan.target.treeDigest, planId };
}

interface InterceptedRequest {
  url: string;
  method: string;
  authorization: string | null;
  accountIdHeader: string | null;
  body: unknown;
}

/** Arms a recorder over globalThis.fetch (the cloud client's default fetch
 * seam — CodexSecurityCloudClient captures globalThis at construction). */
function interceptFetch(responder: (request: InterceptedRequest) => Response): {
  requests: InterceptedRequest[];
  restore: () => void;
} {
  const requests: InterceptedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const request: InterceptedRequest = {
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("Authorization"),
      accountIdHeader: headers.get("ChatGPT-Account-Id"),
      body: bodyText ? (JSON.parse(bodyText) as unknown) : undefined,
    };
    requests.push(request);
    return responder(request);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function openHostSecurityStore() {
  const { SecurityStore } = await import("@oh-my-pi/pi-coding-agent/security/store");
  return SecurityStore.openForCwd(repo);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-security-l1-"));
  repo = join(root, "workspace");
  repoB = join(root, "workspace-b");
  agentDir = join(root, "omp-agent-sec");
  for (const dir of [repo, repoB]) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "baseline readme\n");
    writeFileSync(join(dir, "src", "app.py"), "print('app')\n");
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    symlinkSync("README.md", join(dir, "link"));
    git("init -q -b main", dir);
    git("config user.email sec@test", dir);
    git("config user.name sec", dir);
    git("add -A", dir);
    git("commit -qm baseline", dir);
  }
  // The version gate is the refuse-start precondition (tool-runtime.test.ts)
  // — it runs before ANY omp module graph evaluates.
  assertNativeAddonCurrent(await readNativeAddonStatus());
  const authConfig = decodeAgentAuthConfig(
    JSON.stringify({
      providers: {
        secprov: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          // auth "none": the scan credential is the host-stored OAuth row.
          // A models.yml apiKey would register a provider key override and
          // suppress the OAuth account listing (cascade precedence) — the
          // pin then fails with "require a stored OAuth account".
          auth: "none",
          models: [
            {
              id: "sec-model",
              name: "Sec Model",
              reasoning: false,
              input: ["text"],
              contextWindow: 32_768,
              maxTokens: 4_096,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
      securityModel: "secprov/sec-model",
    }),
  );
  host = await createToolHost(repo, agentDir, MACHINE, authConfig);
  hostSession = host.session as HostSessionSurface;
  // Seed the host-side OAuth rows on the host's OWN authStorage instance (the
  // same object the tool reads): one for the plan's model provider (preflight
  // pins this exact credential), one ChatGPT row for the cloud half.
  const farFuture = Date.now() + 24 * 60 * 60 * 1000;
  // Credential ids share one autoincrement sequence across providers — the
  // second upsert is NOT id 1. Parse the returned rows (omp API shape,
  // outside this file's types) to pin the exact selectors.
  const UpsertedRow = z.object({ id: z.number() });
  const upsert = async (provider: string, credential: Record<string, unknown>): Promise<number> => {
    const stored = await hostSession.authStorage.credentials.upsert(provider, credential);
    return UpsertedRow.parse(stored[0]).id;
  };
  secprovCredentialId = await upsert("secprov", {
    type: "oauth",
    refresh: "sec-refresh",
    access: "sec-model-token",
    expires: farFuture,
    email: "sec@example.test",
    accountId: HOST_ACCOUNT_ID,
  });
  codexCredentialId = await upsert("openai-codex", {
    type: "oauth",
    refresh: "codex-refresh",
    access: HOST_TOKEN,
    expires: farFuture,
    email: "sec@example.test",
    accountId: HOST_ACCOUNT_ID,
  });
  if (codexCredentialId === secprovCredentialId)
    throw new Error("credential id sequence overlapped");
  // The unpinned twin: no agentAuth, no stored accounts — fail-closed host.
  bareHost = await createToolHost(repoB, join(root, "omp-agent-bare"), MACHINE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("T15 #105 — native preflight fingerprint (real omp SecurityScanTool)", () => {
  test("preflight pins an omp-security-tree/v1:sha256 fingerprint deterministically", async () => {
    const first = await preflightFingerprint("sec-pf-1");
    const second = await preflightFingerprint("sec-pf-2");
    expect(second.treeDigest).toBe(first.treeDigest);
    expect(second.planId).not.toBe(first.planId);
    // The fs output plan lands on the host store (fs 输出目录在宿主), with the
    // tree digest, model and EXACT OAuth credential frozen into the plan.
    const store = await openHostSecurityStore();
    const plan = SecurityPlan.parse(
      JSON.parse(
        readFileSync(join(store.projectDirectory, "plans", `${first.planId}.json`), "utf8"),
      ),
    );
    expect(plan.fingerprint).toMatch(/^omp-security-plan\/v1:sha256:[0-9a-f]{64}$/);
    expect(first.treeDigest).toMatch(/^omp-security-tree\/v1:sha256:[0-9a-f]{64}$/);
    expect(plan.model).toMatchObject({ provider: "secprov", modelId: "sec-model" });
    expect(plan.account).toMatchObject({ provider: "secprov", credentialId: secprovCredentialId });
  });

  test("the fingerprint moves on a HEAD change alone (same tree, new commit SHA)", async () => {
    const before = await preflightFingerprint("sec-head-0");
    git("commit -q --amend --no-edit");
    const after = await preflightFingerprint("sec-head-1");
    expect(after.treeDigest).not.toBe(before.treeDigest);
  });

  test("the fingerprint moves on content change", async () => {
    const before = await preflightFingerprint("sec-content-0");
    writeFileSync(join(repo, "README.md"), "baseline readme\nwith one more line\n");
    const after = await preflightFingerprint("sec-content-1");
    expect(after.treeDigest).not.toBe(before.treeDigest);
    git("checkout -q -- README.md");
  });

  test("the fingerprint moves on an executable-bit change", async () => {
    const before = await preflightFingerprint("sec-exec-0");
    chmodSync(join(repo, "run.sh"), 0o644);
    const after = await preflightFingerprint("sec-exec-1");
    expect(after.treeDigest).not.toBe(before.treeDigest);
    chmodSync(join(repo, "run.sh"), 0o755);
  });

  test("the fingerprint moves on a symlink retarget", async () => {
    const before = await preflightFingerprint("sec-link-0");
    unlinkSync(join(repo, "link"));
    symlinkSync("src/app.py", join(repo, "link"));
    const after = await preflightFingerprint("sec-link-1");
    expect(after.treeDigest).not.toBe(before.treeDigest);
    unlinkSync(join(repo, "link"));
    symlinkSync("README.md", join(repo, "link"));
  });
});

describe("T15 #105 — background coordinator + cancel (host side)", () => {
  test("cancel flips an in-flight background operation to cancelled and persists the terminal bundle", async () => {
    // The stub scan session signals prompt() entry (the deterministic "the
    // run reached reviewing") and blocks there until abort — the coordinator's
    // real session factory needs a live model; the semantics under test (queued
    // → reviewing → cancelled, abort propagation, terminal bundle write) are
    // the coordinator's own, which the tool delegates to verbatim.
    const promptEntered = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<void>();
    const { SecurityCoordinator } = await import("@oh-my-pi/pi-coding-agent/security/coordinator");
    const activeModel = hostSession.getActiveModel?.();
    const coordinator = new SecurityCoordinator(
      {
        cwd: repo,
        settings: host.settings,
        authStorage: hostSession.authStorage,
        modelRegistry: hostSession.modelRegistry,
        // omp Model param — the pinned registry model resolved host-side.
        activeModel: activeModel as never,
      },
      {
        createSession: async () => ({
          sessionFile: join(root, "stub-session.jsonl"),
          prompt: async () => {
            promptEntered.resolve();
            await releasePrompt.promise;
            return true;
          },
          waitForIdle: async () => {},
          abort: async () => {
            releasePrompt.resolve();
          },
          dispose: async () => {},
        }),
      },
    );
    const plan = await coordinator.preflight({ model: activeModel as never });
    const operation = await coordinator.start({ planId: plan.id });
    expect(operation.phase).toBe("queued");
    // Background: the run progresses off the start() call (queued → preparing
    // → reviewing) while the stub session blocks in prompt(). Prompt entry is
    // the awaited real signal — the reviewing update lands immediately before
    // the coordinator calls prompt (coordinator.ts:634-636).
    await promptEntered.promise;
    expect((await coordinator.status(operation.operationId))?.phase).toBe("reviewing");

    expect(await coordinator.cancel(operation.operationId)).toBe(true);
    const terminal = await coordinator.wait(operation.operationId);
    expect(terminal.phase).toBe("cancelled");
    expect((await coordinator.status(operation.operationId))?.phase).toBe("cancelled");
    // Cancel is terminal-state idempotent (matrix §2.4 business cancel).
    expect(await coordinator.cancel(operation.operationId)).toBe(false);
    // The terminal bundle with status cancelled persisted on the host.
    const store = await openHostSecurityStore();
    const bundle = CancelledBundle.parse(await store.getBundle(terminal.scanId));
    expect(bundle.scan.status).toBe("cancelled");
  });

  test("status/cancel/start dispatch seams resolve omp's own errors through the frame", async () => {
    const unknownStatus = await executeDispatch(
      host,
      frameOf("security_scan", "sec-status-x", { action: "status", operation_id: "secop_missing" }),
    );
    expect(unknownStatus.status).toBe("error");
    expect(unknownStatus.output).toContain("Unknown security operation: secop_missing");

    const unknownCancel = await executeDispatch(
      host,
      frameOf("security_scan", "sec-cancel-x", { action: "cancel", operation_id: "secop_missing" }),
    );
    expect(unknownCancel.status).toBe("ok");
    expect(unknownCancel.output).toBe("No running operation secop_missing.");

    const unknownPlan = await executeDispatch(
      host,
      frameOf("security_scan", "sec-start-x", { action: "start", plan_id: "secplan_missing" }),
    );
    expect(unknownPlan.status).toBe("error");
    expect(unknownPlan.output).toContain("Unknown security scan plan: secplan_missing");
  });
});

describe("T15 #105 — credentials stay on the host", () => {
  test("the dispatch frame projection carries no auth surface (agnostic 5-field frame)", () => {
    const frame = frameOf("security_scan", "sec-frame", {
      action: "cloud_scans",
      credential_id: 1,
    });
    expect(Object.keys(frame).sort()).toEqual([
      "arguments",
      "executionId",
      "machineId",
      "timeoutMs",
      "tool",
    ]);
    // credential_id is an omp schema field (a host-side account selector), not
    // a secret: it rides arguments verbatim; nothing auth-shaped is added.
    expect(frame.arguments).toEqual({ action: "cloud_scans", credential_id: 1 });
  });

  test("unpinned host: preflight fails closed on the missing active model", async () => {
    const result = await executeDispatch(
      bareHost,
      frameOf("security_scan", "sec-bare-pf", { action: "preflight" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("Security scan preflight requires an active model");
  });

  test("host without a stored ChatGPT account: cloud_scans refuses before any network", async () => {
    const { requests, restore } = interceptFetch(() => Response.json({ items: [] }));
    try {
      const result = await executeDispatch(
        bareHost,
        frameOf("security_scan", "sec-bare-cloud", { action: "cloud_scans" }),
      );
      expect(result.status).toBe("error");
      expect(result.output).toContain(
        "Security scans require a stored OAuth account for openai-codex",
      );
      expect(requests).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("with the host-stored credential: the bearer is resolved host-side and never leaks into the result", async () => {
    const { requests, restore } = interceptFetch(() =>
      Response.json({
        items: [
          {
            hid: "cfg-1",
            scan_input: {
              repo_id: "repo-1",
              repo_url: "https://example.test/repo-1",
              environment_id: "env-1",
            },
            current_step: "idle",
          },
        ],
      }),
    );
    try {
      const result = await executeDispatch(
        host,
        frameOf("security_scan", "sec-cloud-scans", {
          action: "cloud_scans",
          credential_id: codexCredentialId,
        }),
      );
      if (result.status !== "ok") throw new Error(`cloud_scans failed: ${result.output}`);
      expect(result.status).toBe("ok");
      expect(requests).toHaveLength(1);
      // An undefined cursor is omitted from the query (cloud.ts #request).
      expect(requests[0]?.url).toBe(
        "https://chatgpt.com/backend-api/aardvark/scan_configurations?limit=500",
      );
      expect(requests[0]?.authorization).toBe(`Bearer ${HOST_TOKEN}`);
      expect(requests[0]?.accountIdHeader).toBe(HOST_ACCOUNT_ID);
      // The result text names the configuration and never carries the token.
      expect(result.output).toContain("cfg-1");
      expect(result.output).toContain("repo-1");
      expect(result.output).not.toContain(HOST_TOKEN);
    } finally {
      restore();
    }
  });

  test("cloud_start decodes the host credential's JWT subject host-side into the scan input", async () => {
    const { requests, restore } = interceptFetch(() =>
      Response.json({
        hid: "cfg-new",
        scan_input: {
          repo_id: "repo-1",
          repo_url: "https://example.test/repo-1",
          environment_id: "env-1",
          state: "enabled",
        },
      }),
    );
    try {
      const result = await executeDispatch(
        host,
        frameOf("security_scan", "sec-cloud-start", {
          action: "cloud_start",
          repository_id: "repo-1",
          repository_url: "https://example.test/repo-1",
          environment_id: "env-1",
          credential_id: codexCredentialId,
        }),
      );
      if (result.status !== "ok") throw new Error(`cloud_start failed: ${result.output}`);
      expect(result.status).toBe("ok");
      expect(result.output).toContain("Codex Security cloud scan cfg-new started");
      const post = requests.find((request) => request.method === "POST");
      expect(post).toBeDefined();
      expect(post?.authorization).toBe(`Bearer ${HOST_TOKEN}`);
      const body = CloudStartBody.parse(post?.body);
      expect(body.scan_input.owner_id).toBe("sec-user-77");
      expect(body.scan_input.repo_id).toBe("repo-1");
      expect(body.scan_input.state).toBe("enabled");
      expect(result.output).not.toContain(HOST_TOKEN);
    } finally {
      restore();
    }
  });
});
