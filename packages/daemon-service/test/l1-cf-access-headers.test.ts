import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { establishSession, type ClientRuntime } from "../src/client/connection.js";
import { loadIdentity, type ClientConfig } from "../src/client/identity.js";
import {
  cfAccessHeaders,
  decodeCfAccessConfig,
  type CfAccessConfig,
} from "../src/client/cf-access.js";
import { decodeAgentAuthConfig } from "../src/client/agent-auth.js";
import { decodeTaskIsolationConfig } from "../src/client/task-isolation.js";
import { Executor } from "../src/client/executor.js";

/**
 * L1 CF Access service-token injection (#420, cutover checklist step 5 of
 * docs/research/cf-access-agent-compat.md): when cfAccess is configured,
 * EVERY daemon-seam request — /enroll, /session/open, and the /ws attach —
 * carries CF-Access-Client-Id/CF-Access-Client-Secret alongside the
 * existing `authorization: Bearer <hostKey>` (Access is the wall, hostKey
 * the door lock — engineering.md practice 7). Unset config must leave the
 * wire byte-identical to the pre-#420 shape (no-Access direct dial).
 *
 * Harness: the REAL client seam functions (loadIdentity → enroll;
 * establishSession → open + attach) run against a recording fetch and a
 * recording WebSocket stand-in (the bun lane's globalThis override, the
 * l1-security-scan interceptFetch pattern). Bun is the daemon's runtime.
 */

const SERVICE_URL = "https://bb-staging.example.test";
const TOKEN_PAIR = { clientId: "cfid.l1rig.access", clientSecret: "cfast_l1rigsecret" };

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Minimal WebSocket stand-in: records the Bun per-socket headers bag and
 * opens itself on a microtask (listeners attach synchronously after the
 * constructor, so the attach latch resolves). */
class RecordingSocket extends EventTarget {
  static last: { url: string; headers: Record<string, string> } | null = null;
  readonly OPEN = 1;
  readyState = 0;

  constructor(url: string | URL, options?: unknown) {
    super();
    const bag = options as { headers?: Record<string, string> } | undefined;
    RecordingSocket.last = { url: String(url), headers: { ...(bag?.headers ?? {}) } };
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(_raw: string): void {}

  close(): void {
    this.readyState = 3;
  }
}

function clientConfig(cfAccess: CfAccessConfig | undefined, dataDir: string): ClientConfig {
  return {
    baseUrl: SERVICE_URL,
    dataDir,
    sandboxRoot: join(dataDir, "sandbox"),
    enrollKey: "l1-rig-enroll-key",
    joinCode: null,
    taskIsolation: decodeTaskIsolationConfig(undefined),
    agentAuth: decodeAgentAuthConfig(undefined),
    cfAccess,
  };
}

/** Drives the real enroll → session/open → ws attach chain against
 * recording fakes; returns the three captured requests. */
async function captureHandshake(cfAccess: CfAccessConfig | undefined): Promise<{
  enroll: CapturedRequest;
  open: CapturedRequest;
  ws: { url: string; headers: Record<string, string> };
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-access-l1-"));
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    if (url === `${SERVICE_URL}/enroll`) {
      return new Response(JSON.stringify({ hostId: "host_cfaccessl1", hostKey: "rig-host-key" }), {
        status: 201,
      });
    }
    if (url === `${SERVICE_URL}/session/open`) {
      return new Response(
        JSON.stringify({
          sessionId: "sess_cfaccessl1",
          heartbeatIntervalMs: 3_600_000,
          leaseTimeoutMs: 60_000,
        }),
        { status: 201 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  globalThis.WebSocket = RecordingSocket as unknown as typeof WebSocket;
  try {
    const config = clientConfig(cfAccess, dataDir);
    const identity = await loadIdentity(config); // enroll leg (persists 0600 files)
    const runtime: ClientRuntime = {
      bootId: "boot_cfaccessl1",
      executor: new Executor(config.sandboxRoot),
      machineId: null,
      toolRuntime: null,
      buffers: new Map(),
      generation: 0,
      session: null,
      heartbeatTimer: null,
      flushTimer: null,
      connectedAt: 0,
      sessionId: null,
      attachmentFetcher: null,
      queue: [],
      queueBusy: false,
    };
    await establishSession(config, identity, runtime); // open + attach legs
    clearInterval(runtime.heartbeatTimer);
    clearInterval(runtime.flushTimer);
    const byPath = (path: string): CapturedRequest => {
      const hit = calls.find((call) => call.url === `${SERVICE_URL}${path}`);
      if (hit === undefined) throw new Error(`no captured call to ${path}`);
      return hit;
    };
    if (RecordingSocket.last === null) throw new Error("no ws attach captured");
    return { enroll: byPath("/enroll"), open: byPath("/session/open"), ws: RecordingSocket.last };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("L1 daemon-client CF Access header injection (#420)", () => {
  test("configured: all three seams carry the service-token pair (hostKey still parallel)", async () => {
    const seam = await captureHandshake(TOKEN_PAIR);

    // /enroll — the CF pair is the ONLY credential here (enroll mints the hostKey).
    expect(seam.enroll.headers["content-type"]).toBe("application/json");
    expect(seam.enroll.headers["CF-Access-Client-Id"]).toBe(TOKEN_PAIR.clientId);
    expect(seam.enroll.headers["CF-Access-Client-Secret"]).toBe(TOKEN_PAIR.clientSecret);
    expect(seam.enroll.headers.authorization).toBeUndefined();

    // /session/open — CF pair AND the Bearer hostKey, in parallel.
    expect(seam.open.headers["content-type"]).toBe("application/json");
    expect(seam.open.headers.authorization).toBe("Bearer rig-host-key");
    expect(seam.open.headers["CF-Access-Client-Id"]).toBe(TOKEN_PAIR.clientId);
    expect(seam.open.headers["CF-Access-Client-Secret"]).toBe(TOKEN_PAIR.clientSecret);

    // /ws attach — same pairing on the upgrade request (BUN_WS_HEADERS bag).
    expect(seam.ws.url).toBe(
      `${SERVICE_URL.replace(/^http/, "ws")}/ws?hostId=host_cfaccessl1&sessionId=sess_cfaccessl1`,
    );
    expect(seam.ws.headers.authorization).toBe("Bearer rig-host-key");
    expect(seam.ws.headers["CF-Access-Client-Id"]).toBe(TOKEN_PAIR.clientId);
    expect(seam.ws.headers["CF-Access-Client-Secret"]).toBe(TOKEN_PAIR.clientSecret);
  });

  test("unconfigured: no CF headers on any seam — the direct-dial wire is unchanged", async () => {
    const seam = await captureHandshake(undefined);
    for (const captured of [seam.enroll, seam.open, seam.ws]) {
      expect(captured.headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(captured.headers["CF-Access-Client-Secret"]).toBeUndefined();
    }
    // hostKey ladder untouched: enroll bare, open/attach Bearer.
    expect(seam.enroll.headers.authorization).toBeUndefined();
    expect(seam.open.headers.authorization).toBe("Bearer rig-host-key");
    expect(seam.ws.headers.authorization).toBe("Bearer rig-host-key");
    expect(seam.ws.url).toBe(
      `${SERVICE_URL.replace(/^http/, "ws")}/ws?hostId=host_cfaccessl1&sessionId=sess_cfaccessl1`,
    );
  });

  test("decodeCfAccessConfig: both halves or neither; cfAccessHeaders spreads empty", () => {
    expect(decodeCfAccessConfig(undefined, undefined)).toBeUndefined();
    expect(decodeCfAccessConfig(TOKEN_PAIR.clientId, TOKEN_PAIR.clientSecret)).toEqual(TOKEN_PAIR);
    // systemd EnvironmentFile `KEY=` lines degrade to unset, not a half pair.
    expect(decodeCfAccessConfig("", "")).toBeUndefined();
    expect(() => decodeCfAccessConfig(TOKEN_PAIR.clientId, undefined)).toThrow(/credential pair/);
    expect(() => decodeCfAccessConfig(undefined, TOKEN_PAIR.clientSecret)).toThrow(
      /credential pair/,
    );
    expect(() => decodeCfAccessConfig(TOKEN_PAIR.clientId, "")).toThrow(/credential pair/);
    expect(cfAccessHeaders(undefined)).toEqual({});
    expect(cfAccessHeaders(TOKEN_PAIR)).toEqual({
      "CF-Access-Client-Id": TOKEN_PAIR.clientId,
      "CF-Access-Client-Secret": TOKEN_PAIR.clientSecret,
    });
  });
});
