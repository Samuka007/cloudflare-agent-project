import { describe, expect, test } from "vitest";
import type { RelayCatalogProvider } from "@cap/agent-config";
import {
  decryptProviderSecret,
  encryptProviderSecret,
  loadProviderConfigCatalogOverlay,
  resolveOverlayCatalog,
} from "../src/index";

/**
 * #362/#450 provider configurable panel: the crypto half (AES-256-GCM over the
 * D1 api_key_enc column), the D1-only overlay resolution (each row IS its
 * catalog entry — row-level, whole-row; there is no env seed to merge over
 * since #450), and the registry's standalone-credential posture
 * (user-configured rows never fall back to deployment relay slots — the
 * credential-leak red line).
 */

const MASTER_KEY = "unit-rig-master-key";

describe("#362 provider-config crypto (AES-256-GCM)", () => {
  test("roundtrips a secret through the column payload format", async () => {
    const payload = await encryptProviderSecret(MASTER_KEY, "sk-unit-362");
    expect(payload).not.toContain("sk-unit-362");
    expect(await decryptProviderSecret(MASTER_KEY, payload)).toBe("sk-unit-362");
  });

  test("a fresh IV makes every encryption unique — rotations are observable", async () => {
    const first = await encryptProviderSecret(MASTER_KEY, "same-key-value");
    const second = await encryptProviderSecret(MASTER_KEY, "same-key-value");
    expect(first).not.toBe(second);
    expect(await decryptProviderSecret(MASTER_KEY, second)).toBe("same-key-value");
  });

  test("a foreign master key cannot decrypt (auth-tag mismatch throws)", async () => {
    const payload = await encryptProviderSecret(MASTER_KEY, "sk-unit-362");
    await expect(decryptProviderSecret("another-rig-key", payload)).rejects.toThrow();
  });

  test("tampered and truncated payloads throw instead of half-decrypting", async () => {
    const payload = await encryptProviderSecret(MASTER_KEY, "sk-unit-362");
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    const last = bytes[bytes.length - 1] ?? 0;
    bytes[bytes.length - 1] = last ^ 0xff; // flip one ciphertext/tag bit
    await expect(
      decryptProviderSecret(MASTER_KEY, btoa(String.fromCharCode(...bytes))),
    ).rejects.toThrow();
    await expect(
      decryptProviderSecret(MASTER_KEY, btoa(String.fromCharCode(1, 2, 3))),
    ).rejects.toThrow(/truncated/);
  });
});

const OVERLAY_PROVIDERS: Record<string, RelayCatalogProvider> = {
  envp: {
    displayName: "Panel Row",
    api: "openai-responses",
    models: [{ id: "panel-model" }],
  },
  panelp: { api: "anthropic-messages", models: [{ id: "panel-only" }] },
};

describe("#362/#450 the overlay IS the directory (loader rows are row-level whole-row)", () => {
  test("every decoded row projects verbatim; one row replacing another is a row write away", () => {
    // The loader hands the registry rows keyed by id; the projection is the
    // rows themselves — an id swap on the panel swaps the directory entry
    // wholesale (whole-row semantics, #434: nothing is synthesized back).
    const first = resolveOverlayCatalog(OVERLAY_PROVIDERS);
    expect(first.configured).toBe(true);
    expect(first.providers.map((provider) => provider.id)).toEqual(["envp", "panelp"]);
    expect(first.models.map((model) => model.id)).toEqual(["panel-model", "panel-only"]);

    // A panel write that replaces the envp row's declaration replaces the
    // whole entry — the previous declaration's models are gone entirely.
    const rewritten = resolveOverlayCatalog({
      envp: { displayName: "Rewritten", models: [{ id: "rewritten-model" }] },
      panelp: OVERLAY_PROVIDERS.panelp ?? { models: [] },
    });
    expect(rewritten.models.map((model) => model.id)).toEqual(["rewritten-model", "panel-only"]);
    expect(rewritten.models.filter((model) => model.id === "panel-model")).toHaveLength(0);
  });

  test("zero rows is the honest empty directory — nothing rides in its place", () => {
    const empty = resolveOverlayCatalog({});
    expect(empty.configured).toBe(false);
    expect(empty.decodeError).toBe(false);
    expect(empty.providers).toEqual([]);
    expect(empty.models).toEqual([]);
  });
});

// #434 point 6 retired seedProviderConfigRows: the CRUD display face lists
// ONLY user rows. The wire-level guarantees live in the server-worker L1
// suite (system-provider-configs.test.ts).
describe("#362 catalog overlay", () => {
  test("the catalog overlay loader never returns credential material", async () => {
    // No DB binding → null (the loader is a no-op without D1), which is the
    // zero-secret-by-construction contract for pure catalog faces.
    await expect(loadProviderConfigCatalogOverlay({})).resolves.toBeNull();
  });
});
