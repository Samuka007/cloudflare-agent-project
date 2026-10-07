import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import { newThreadId } from "@cap/protocol";
import type { AgentDO } from "../src/agent-do.js";
import { DEFAULT_WATCHDOG_CONFIG, WATCHDOG_CONFIG_KV_KEY } from "../src/config.js";
import { agentNamespace, createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #501: the watchdog config read order is single-layer — the DO's KV patch
 * row (`watchdog-config`) over DEFAULT_WATCHDOG_CONFIG. An absent row (or an
 * absent field) IS the code default; the env patch channel is retired, so
 * recovery must land on exactly this decode and nothing else.
 *
 * These pins run the real cold-start paths (`abortAllDurableObjects` hard
 * kill / `evictDurableObject` targeted) and read the live `cfg` through the
 * in-DO test seam.
 */

afterEach(() => {
  resetRuntime();
});

/** The live cfg + the raw KV row, read inside the DO instance. */
async function cfgStateOf(rig: Rig): Promise<{ cfg: unknown; row: string | undefined }> {
  return runInDurableObject(rig.stub, (instance, state) => {
    const seam = instance as unknown as { cfg: unknown };
    return {
      cfg: seam.cfg,
      row: state.storage.kv.get<string>(WATCHDOG_CONFIG_KV_KEY),
    };
  });
}

describe("watchdog config 正本 (#501)", () => {
  test("absent KV row → the code defaults survive revival (no env layer)", async () => {
    const rig = await createRig();
    await abortAllDurableObjects();
    await rig.afterAbort(() => rig.events()); // revival runs recover()
    const { cfg, row } = await cfgStateOf(rig);
    expect(row).toBeUndefined();
    expect(cfg).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });

  test("KV patch row decodes over the defaults — absent fields = defaults", async () => {
    const rig = await createRig({ watchdog: { deltaFlushMs: 250, turnWatchdogMs: 90_000 } });
    await abortAllDurableObjects();
    await rig.afterAbort(() => rig.events());
    const { cfg, row } = await cfgStateOf(rig);
    expect(JSON.parse(row ?? "null")).toEqual({ deltaFlushMs: 250, turnWatchdogMs: 90_000 });
    expect(cfg).toEqual({
      ...DEFAULT_WATCHDOG_CONFIG,
      deltaFlushMs: 250,
      turnWatchdogMs: 90_000,
    });
  });

  test("a patch written before createThread survives eviction (threadless adoption)", async () => {
    const threadId = newThreadId();
    const stub = agentNamespace.get(
      agentNamespace.idFromName(threadId),
    ) as DurableObjectStub<AgentDO>;
    // The write face serves threadless DOs too (the POC rig injects its drill
    // timings before the first POST /drive); eviction must not drop the row —
    // recover() adopts it regardless of thread presence (#501).
    await stub.configureWatchdog({ deltaFlushMs: 250 });
    await evictDurableObject(stub);
    const rig = await createRig({ threadId });
    const { cfg, row } = await cfgStateOf(rig);
    expect(JSON.parse(row ?? "null")).toEqual({ deltaFlushMs: 250 });
    expect(cfg).toEqual({ ...DEFAULT_WATCHDOG_CONFIG, deltaFlushMs: 250 });
  });
});
