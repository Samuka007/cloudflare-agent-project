import { describe, expect, test } from "vitest";
import type { RelayCatalogProvider } from "@cap/agent-do";
import {
  decryptProviderSecret,
  imageGenerationSourceFromOverlay,
  encryptProviderSecret,
  loadProviderConfigCatalogOverlay,
  resolveOverlayCatalog,
  RelayProviderRegistry,
} from "../src/index.js";
import { DEFAULT_IMAGE_TIMEOUT_SECONDS } from "@cap/agent-do";

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
describe("#362 RelayProviderRegistry overlay (standalone credentials)", () => {
  test("an overlay row resolves with its OWN wire identity, never deployment slots", () => {
    const registry = RelayProviderRegistry.create();
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      imageSourceProviderId: null,
      credentials: { panelp: { apiKey: "k-panel", baseUrl: "https://panel.example.com" } },
    });
    const standalone = registry.resolve({ providerId: "panelp", model: "panel-only" });
    expect(standalone.config.apiKey).toBe("k-panel");
    expect(standalone.config.baseUrl).toBe("https://panel.example.com");
    // The SAME-ID row the panel rewrote (envp) has no credential slot — its
    // wire slots stay empty (the #450/#500 standalone posture: a user row is
    // never hit with a shared credential).
    const rewritten = registry.resolve({ providerId: "envp", model: "panel-model" });
    expect(rewritten.config.apiKey).toBe("");
    expect(rewritten.config.baseUrl).toBe("");
  });

  test("an incomplete overlay row fails dispatch with the named credential error", () => {
    const registry = RelayProviderRegistry.create();
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      imageSourceProviderId: null,
      credentials: {},
    });
    // #434 point ⑦: no row-level mock. resolve() still answers (the config
    // slots are honestly empty), but dispatch refuses to fabricate a client.
    expect(() => registry.providerFor({ providerId: "panelp", model: "panel-only" })).toThrow(
      /panelp.*no usable credential/s,
    );
    // The refusal never fabricates a credential into the row's wire slots.
    const resolved = registry.resolve({ providerId: "panelp", model: "panel-only" });
    expect(resolved.config.apiKey).toBe("");
    expect(resolved.config.baseUrl).toBe("");
  });

  test("applyOverlay clears the instance cache — stale wire clients never survive a rotation", () => {
    const registry = RelayProviderRegistry.create();
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      imageSourceProviderId: null,
      credentials: { panelp: { apiKey: "k-one", baseUrl: "https://panel.example.com" } },
    });
    const first = registry.providerFor({ providerId: "panelp", model: "panel-only" });
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      imageSourceProviderId: null,
      credentials: { panelp: { apiKey: "k-two", baseUrl: "https://panel.example.com" } },
    });
    const second = registry.providerFor({ providerId: "panelp", model: "panel-only" });
    expect(second).not.toBe(first);
    expect(registry.resolve({ providerId: "panelp", model: "panel-only" }).config.apiKey).toBe(
      "k-two",
    );
  });

  test("the catalog overlay loader never returns credential material", async () => {
    // No DB binding → null (the loader is a no-op without D1), which is the
    // zero-secret-by-construction contract for pure catalog faces.
    await expect(loadProviderConfigCatalogOverlay({})).resolves.toBeNull();
  });

  test("imageGenerationSourceFromOverlay resolves the explicitly seated openai-images row", () => {
    expect(imageGenerationSourceFromOverlay(null)).toBeNull();
    expect(
      imageGenerationSourceFromOverlay({
        providers: {},
        imageSourceProviderId: null,
        credentials: {},
      }),
    ).toBeNull();
    // #448: a seat is mandatory — rows without the seat supply nothing.
    expect(
      imageGenerationSourceFromOverlay({
        providers: {
          imagey: {
            api: "openai-images",
            baseUrl: "https://images.example.com/v1/",
            models: [{ id: "image-model" }, { id: "spare" }],
          },
        },
        imageSourceProviderId: null,
        credentials: { imagey: { apiKey: "sk-image-362" } },
      }),
    ).toBeNull();
    const source = imageGenerationSourceFromOverlay({
      providers: {
        imagey: {
          api: "openai-images",
          baseUrl: "https://images.example.com/v1/",
          models: [{ id: "image-model" }, { id: "spare" }],
        },
      },
      imageSourceProviderId: "imagey",
      credentials: { imagey: { apiKey: "sk-image-362" } },
    });
    expect(source).toEqual({
      baseUrl: "https://images.example.com/v1",
      apiKey: "sk-image-362",
      model: "image-model",
      timeoutSeconds: DEFAULT_IMAGE_TIMEOUT_SECONDS,
    });
    // A seat naming a missing or non-image row is honestly unconfigured.
    expect(
      imageGenerationSourceFromOverlay({
        providers: {},
        imageSourceProviderId: "gone",
        credentials: {},
      }),
    ).toBeNull();
    expect(
      imageGenerationSourceFromOverlay({
        providers: {
          texty: {
            api: "anthropic-messages",
            baseUrl: "https://relay.example.com",
            models: [{ id: "m" }],
          },
        },
        imageSourceProviderId: "texty",
        credentials: { texty: { apiKey: "k" } },
      }),
    ).toBeNull();
  });
});
