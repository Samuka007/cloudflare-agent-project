import { describe, expect, test } from "vitest";
import type { RelayCatalogProvider } from "@cap/agent-do";
import {
  decryptProviderSecret,
  imageGenerationSourceFromOverlay,
  encryptProviderSecret,
  loadProviderConfigCatalogOverlay,
  RelayProviderRegistry,
  resolveRelayCatalogWithOverlay,
} from "../src/index.js";
import { DEFAULT_IMAGE_TIMEOUT_SECONDS } from "@cap/agent-do";
import { FixedReplyProvider } from "../src/harness.js";

/**
 * #362 provider configurable panel: the crypto half (AES-256-GCM over the D1
 * api_key_enc column), the overlay merge (env seed ⊕ D1 rows, D1 wins), and
 * the registry's standalone-credential posture (user-configured rows never
 * fall back to deployment relay slots — the credential-leak red line).
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

const ENV_CATALOG = JSON.stringify({
  defaultProvider: "envp",
  providers: {
    envp: { displayName: "Env Provider", models: [{ id: "env-model", name: "Env Model" }] },
  },
});
const ENV_CREDENTIALS = JSON.stringify({
  envp: { apiKey: "k-deployment", baseUrl: "https://env-relay.example.com" },
});
const OVERLAY_PROVIDERS: Record<string, RelayCatalogProvider> = {
  envp: {
    displayName: "Panel Override",
    api: "openai-responses",
    models: [{ id: "panel-model" }],
  },
  panelp: { api: "anthropic-messages", models: [{ id: "panel-only" }] },
};

describe("#362 resolveRelayCatalogWithOverlay (merge resolution)", () => {
  test("same-id D1 rows replace the env declaration wholesale; new ids join", () => {
    const merged = resolveRelayCatalogWithOverlay(
      { MODEL_RELAY_CATALOG: ENV_CATALOG },
      OVERLAY_PROVIDERS,
    );
    const byId = new Map(merged.providers.map((provider) => [provider.id, provider]));
    expect(byId.get("envp")?.displayName).toBe("Panel Override");
    expect(byId.has("panelp")).toBe(true);
    const modelIds = merged.models.map((model) => model.id);
    expect(modelIds).toContain("panel-model");
    expect(modelIds).toContain("panel-only");
    // The declared env row is gone; only the synthesized running row remains.
    expect(merged.models.filter((model) => model.id === "env-model")).toHaveLength(1);
    expect(merged.defaultProviderId).toBe("envp");
  });

  test("a broken env seed keeps its loud decodeError while overlay rows still serve", () => {
    const merged = resolveRelayCatalogWithOverlay(
      { MODEL_RELAY_CATALOG: "{not-json" },
      OVERLAY_PROVIDERS,
    );
    expect(merged.decodeError).toBe(true);
    expect(merged.configured).toBe(true);
    expect(merged.providers.map((provider) => provider.id)).toEqual(["envp", "panelp"]);
  });

  test("zero overlay rows falls through byte-identical to the plain resolution", () => {
    const plain = resolveRelayCatalogWithOverlay({ MODEL_RELAY_CATALOG: ENV_CATALOG }, {});
    expect(plain.configured).toBe(true);
    expect(plain.decodeError).toBe(false);
    expect(plain.providers.map((provider) => provider.id)).toEqual(["envp"]);
    expect(plain.models.map((model) => model.id)).toContain("env-model");
  });
});

describe("#362 RelayProviderRegistry overlay (standalone credentials)", () => {
  test("an overlay row resolves with its OWN wire identity, never deployment slots", () => {
    const registry = RelayProviderRegistry.fromEnv({
      MODEL_RELAY_CATALOG: ENV_CATALOG,
      MODEL_RELAY_API_KEY: "k-deployment",
      MODEL_RELAY_BASE_URL_ANTHROPIC: "https://env-relay.example.com",
      MODEL_RELAY_PROVIDER_CREDENTIALS: ENV_CREDENTIALS,
    });
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      credentials: { panelp: { apiKey: "k-panel", baseUrl: "https://panel.example.com" } },
      standaloneProviders: new Set(Object.keys(OVERLAY_PROVIDERS)),
    });
    const standalone = registry.resolve({ providerId: "panelp", model: "panel-only" });
    expect(standalone.config.apiKey).toBe("k-panel");
    expect(standalone.config.baseUrl).toBe("https://panel.example.com");
    // The SAME-ID override (envp) must NOT ride the env credential slot with
    // the user's baseUrl — that is the leak vector the posture exists for.
    const overridden = registry.resolve({ providerId: "envp", model: "panel-model" });
    expect(overridden.config.apiKey).toBe("");
    expect(overridden.config.baseUrl).toBe("");
  });

  test("an incomplete overlay row rides the row-level mock with a naming message", () => {
    const registry = RelayProviderRegistry.fromEnv({
      MODEL_RELAY_CATALOG: ENV_CATALOG,
      MODEL_RELAY_API_KEY: "k-deployment",
    });
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      credentials: {},
      standaloneProviders: new Set(Object.keys(OVERLAY_PROVIDERS)),
    });
    const provider = registry.providerFor({ providerId: "panelp", model: "panel-only" });
    // The row-level mock (not a deployment-credential client); the message
    // text naming the row is proven end-to-end by the L1 turn test.
    expect(provider).toBeInstanceOf(FixedReplyProvider);
    const resolved = registry.resolve({ providerId: "panelp", model: "panel-only" });
    expect(resolved.config.apiKey).toBe("");
    expect(resolved.config.baseUrl).toBe("");
  });

  test("applyOverlay clears the instance cache — stale wire clients never survive a rotation", () => {
    const registry = RelayProviderRegistry.fromEnv({ MODEL_RELAY_CATALOG: ENV_CATALOG });
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      credentials: { panelp: { apiKey: "k-one", baseUrl: "https://panel.example.com" } },
      standaloneProviders: new Set(Object.keys(OVERLAY_PROVIDERS)),
    });
    const first = registry.providerFor({ providerId: "panelp", model: "panel-only" });
    registry.applyOverlay({
      providers: OVERLAY_PROVIDERS,
      credentials: { panelp: { apiKey: "k-two", baseUrl: "https://panel.example.com" } },
      standaloneProviders: new Set(Object.keys(OVERLAY_PROVIDERS)),
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

  test("imageGenerationSourceFromOverlay resolves the openai-images row's source", () => {
    expect(imageGenerationSourceFromOverlay(null)).toBeNull();
    expect(imageGenerationSourceFromOverlay({ providers: {}, credentials: {}, standaloneProviders: new Set() })).toBeNull();
    const source = imageGenerationSourceFromOverlay({
      providers: {
        imagey: {
          api: "openai-images",
          baseUrl: "https://images.example.com/v1/",
          models: [{ id: "image-model" }, { id: "spare" }],
        },
      },
      credentials: { imagey: { apiKey: "sk-image-362" } },
      standaloneProviders: new Set(["imagey"]),
    });
    expect(source).toEqual({
      baseUrl: "https://images.example.com/v1",
      apiKey: "sk-image-362",
      model: "image-model",
      timeoutSeconds: DEFAULT_IMAGE_TIMEOUT_SECONDS,
    });
  });
});
