import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "../migrations-ledger";
import { RIG_MASTER_KEY } from "../helpers";
import {
  absentCompactionSettings,
  createSettingsRepository,
  webSearchHasSecrets,
  type SettingsRepository,
} from "../../src/db/repositories/settings";
import { defaultAppSettings } from "../../src/contract/domain/app-settings";
import { defaultExperiments } from "../../src/contract/domain/experiments";
import type { AppKeybindingOverrides } from "../../src/contract/domain/app-keybindings";

/**
 * #596 the settings-aggregate repository interface seam (W6 db campaign T4).
 *
 * The nine legacy single-row seat tables collapsed into settings_app +
 * settings_agent + system_experiments (src/db/schema.ts); this suite pins the
 * repository BEHAVIOR on the drizzle-era database (env.DB_V2, ledger-applied)
 * — the absent-seat postures, the targeted-column write isolation, and the
 * corrupt-cell decode disciplines the compat suites pin on the legacy faces.
 * No SQL pins: every assertion goes through the repository interface (the
 * raw D1 writes below are test-rig hand-edits, the same tool the legacy
 * suites use to simulate corrupted operator input).
 */

const SETTINGS_TABLES = ["settings_app", "settings_agent", "system_experiments"];

let repo: SettingsRepository;

/** The rig's armed master key — the value vitest.config binds as
 * PROVIDER_CONFIG_MASTER_KEY (the secret is not in the generated Env type). */
const MASTER_KEY = RIG_MASTER_KEY;

async function handEdit(table: string, setSql: string): Promise<void> {
  const rowId = table === "settings_agent" ? "agent" : "app";
  await env.DB_V2.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`).bind(rowId).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB_V2);
  repo = createSettingsRepository(env.DB_V2, MASTER_KEY);
});

afterEach(async () => {
  for (const table of SETTINGS_TABLES) {
    await env.DB_V2.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(async () => {
  // The migrations-ledger suite shares this database; leave it seed-only.
  for (const table of SETTINGS_TABLES) {
    await env.DB_V2.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("settings_app domain — absent-row postures", () => {
  it("returns the ruled defaults for every unset app face", async () => {
    expect(await repo.getAppSettings()).toEqual(defaultAppSettings);
    expect(await repo.getKeybindingOverrides()).toEqual([]);
    expect(await repo.getStoredAppearance()).toBeNull();
    expect((await repo.getOriginAllowlist()).size).toBe(0);
  });
});

describe("settings_app domain — preferences face", () => {
  it("round-trips a non-default settings write", async () => {
    await repo.setAppSettings({
      caffeinate: true,
      showKeyboardHints: false,
      steerActiveThreadOnEnter: true,
      showUnhandledProviderEvents: true,
      codexMemoryEnabled: false,
      claudeCodeMemoryEnabled: false,
      codexSubagentsDisabled: true,
      claudeCodeSubagentsDisabled: true,
      claudeCodeWorkflowsDisabled: true,
      onboardingCompletedAt: "2026-10-20T00:00:00.000Z",
    });
    expect(await repo.getAppSettings()).toEqual({
      caffeinate: true,
      showKeyboardHints: false,
      steerActiveThreadOnEnter: true,
      showUnhandledProviderEvents: true,
      codexMemoryEnabled: false,
      claudeCodeMemoryEnabled: false,
      codexSubagentsDisabled: true,
      claudeCodeSubagentsDisabled: true,
      claudeCodeWorkflowsDisabled: true,
      onboardingCompletedAt: "2026-10-20T00:00:00.000Z",
    });
  });

  it("full-row replace preserves the keybinding overrides column (legacy COALESCE parity)", async () => {
    const overrides: AppKeybindingOverrides = [
      {
        command: "thread.new",
        shortcut: { key: "n", mod: true, meta: false, control: true, alt: false, shift: true },
      },
      { command: "thread.search", shortcut: null },
    ];
    await repo.setKeybindingOverrides(overrides);
    await repo.setAppSettings({ ...defaultAppSettings, caffeinate: true });
    expect(await repo.getKeybindingOverrides()).toEqual(overrides);
  });

  it("creates the singleton row at most once across repeated writes", async () => {
    await repo.setAppSettings({ ...defaultAppSettings, caffeinate: true });
    await repo.setAppSettings({ ...defaultAppSettings, showKeyboardHints: false });
    const count = await env.DB_V2.prepare(
      "SELECT COUNT(*) AS n FROM settings_app WHERE id = 'app'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
    // The second write is a full-row replace: caffeinate is back to its
    // default, only showKeyboardHints moved.
    expect(await repo.getAppSettings()).toEqual({
      ...defaultAppSettings,
      showKeyboardHints: false,
    });
  });

  it("degrades a corrupt overrides cell to [] without throwing", async () => {
    await repo.setKeybindingOverrides([]);
    await handEdit("settings_app", "keybinding_overrides = 'not-json'");
    expect(await repo.getKeybindingOverrides()).toEqual([]);
  });
});

describe("settings_app domain — theme face", () => {
  it("round-trips the appearance and reports null while unset", async () => {
    await repo.setStoredAppearance({ themeId: "dracula-light", faviconColor: "#123456" });
    expect(await repo.getStoredAppearance()).toEqual({
      themeId: "dracula-light",
      faviconColor: "#123456",
    });
    await repo.setStoredAppearance({ themeId: "nord-light", faviconColor: null });
    expect(await repo.getStoredAppearance()).toEqual({ themeId: "nord-light", faviconColor: null });
  });

  it("reports null theme even when another domain created the row", async () => {
    await repo.setKeybindingOverrides([]);
    expect(await repo.getStoredAppearance()).toBeNull();
  });
});

describe("settings_app domain — origin allowlist face", () => {
  it("round-trips canonical origins through the set face", async () => {
    await repo.setOriginAllowlist(["https://a.example.com", "http://b.example.com:8443"]);
    const allowlist = await repo.getOriginAllowlist();
    expect([...allowlist]).toEqual(["https://a.example.com", "http://b.example.com:8443"]);
  });

  it("decodes fail-closed: garbage never widens the gate", async () => {
    await repo.setOriginAllowlist(["https://a.example.com"]);
    await handEdit("settings_app", "origin_allowlist = 'not-json'");
    expect((await repo.getOriginAllowlist()).size).toBe(0);
    await handEdit("settings_app", 'origin_allowlist = \'{"not":"array"}\'');
    expect((await repo.getOriginAllowlist()).size).toBe(0);
    // A non-string entry is dropped, the strict origins around it survive.
    await handEdit("settings_app", `origin_allowlist = '["https://ok.example.com", 42]'`);
    expect([...(await repo.getOriginAllowlist())]).toEqual(["https://ok.example.com"]);
    await handEdit(
      "settings_app",
      `origin_allowlist = '["https://with.path.example.com/path", "ftp://wrong.example.com"]'`,
    );
    expect((await repo.getOriginAllowlist()).size).toBe(0);
    // A trailing slash IS the root path: the URL parses, the origin survives.
    await handEdit("settings_app", `origin_allowlist = '["https://with.path.example.com/"]'`);
    expect([...(await repo.getOriginAllowlist())]).toEqual(["https://with.path.example.com"]);
  });
});

describe("system_experiments domain", () => {
  it("returns the defaults when no toggle was ever saved", async () => {
    expect(await repo.getExperiments()).toEqual(defaultExperiments);
  });

  it("persists every key as one row and overwrites prior values", async () => {
    await repo.setExperiments({ ...defaultExperiments, editMessages: false });
    const stored = await env.DB_V2.prepare("SELECT key, value FROM system_experiments").all<{
      key: string;
      value: number;
    }>();
    expect(stored.results).toEqual([
      { key: "claudeCodeMockCliTraffic", value: 0 },
      { key: "editMessages", value: 0 },
      { key: "newOnboarding", value: 0 },
      { key: "providerSessionReaping", value: 0 },
    ]);
    await repo.setExperiments({ ...defaultExperiments, editMessages: true });
    expect(await repo.getExperiments()).toEqual({ ...defaultExperiments, editMessages: true });
  });

  it("ignores unknown stored keys (open k/v, zod face owns the vocabulary)", async () => {
    await env.DB_V2.prepare(
      "INSERT INTO system_experiments (key, value, updated_at) VALUES ('retiredExperiment', 1, 0)",
    ).run();
    expect(await repo.getExperiments()).toEqual(defaultExperiments);
  });
});

describe("settings_agent domain — permission mode", () => {
  it("reports the absent-seat 'full' default", async () => {
    expect(await repo.getPermissionMode()).toEqual({ configured: false, mode: "full" });
  });

  it("round-trips a stored mode", async () => {
    await repo.setPermissionMode("auto");
    expect(await repo.getPermissionMode()).toEqual({ configured: true, mode: "auto" });
    await repo.setPermissionMode("accept-edits");
    expect(await repo.getPermissionMode()).toEqual({ configured: true, mode: "accept-edits" });
  });

  it("falls back to 'full' on an off-vocabulary stored value while staying configured", async () => {
    await repo.setPermissionMode("auto");
    await handEdit("settings_agent", "permission_mode = 'workspace-write'");
    expect(await repo.getPermissionMode()).toEqual({ configured: true, mode: "full" });
  });
});

describe("settings_agent domain — tool capabilities", () => {
  it("reports the all-off omp posture while unset", async () => {
    expect(await repo.getToolCapabilities()).toEqual({
      configured: false,
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
    });
  });

  it("reports unconfigured when only another domain wrote the row", async () => {
    await repo.setPermissionMode("auto");
    const state = await repo.getToolCapabilities();
    expect(state.configured).toBe(false);
    expect(state.externalThinking).toBe(false);
  });

  it("round-trips the three gates wholesale", async () => {
    await repo.setToolCapabilities({
      externalThinking: true,
      contextNotes: false,
      checkpoint: true,
    });
    expect(await repo.getToolCapabilities()).toEqual({
      configured: true,
      externalThinking: true,
      contextNotes: false,
      checkpoint: true,
    });
  });

  it("decodes strict 0/1: a hand-edited 2 stays off", async () => {
    await repo.setToolCapabilities({
      externalThinking: true,
      contextNotes: true,
      checkpoint: true,
    });
    await handEdit("settings_agent", "external_thinking = 2");
    expect(await repo.getToolCapabilities()).toEqual({
      configured: true,
      externalThinking: false,
      contextNotes: true,
      checkpoint: true,
    });
  });
});

describe("settings_agent domain — compaction settings", () => {
  it("returns the absent-seat soft-only posture", async () => {
    expect(await repo.getCompactionSettings()).toEqual(absentCompactionSettings());
  });

  it("round-trips the order and the remote summarizer", async () => {
    await repo.setCompactionSettings({
      methodOrder: ["remote", "soft"],
      remote: { providerId: "prov-1", model: "glm-5.3" },
    });
    expect(await repo.getCompactionSettings()).toEqual({
      configured: true,
      methodOrder: ["remote", "soft"],
      remote: { providerId: "prov-1", model: "glm-5.3" },
    });
  });

  it("stores remote-eligible nulls when no summarizer is selected", async () => {
    await repo.setCompactionSettings({ methodOrder: ["soft"], remote: null });
    expect(await repo.getCompactionSettings()).toEqual({
      configured: true,
      methodOrder: ["soft"],
      remote: null,
    });
  });

  it("re-resolves operator input at every read: garbage order degrades, dupes/vocabulary filtered", async () => {
    await repo.setCompactionSettings({ methodOrder: ["soft"], remote: null });
    await handEdit("settings_agent", "compaction_method_order = 'not-json'");
    expect(await repo.getCompactionSettings()).toEqual({
      configured: true,
      methodOrder: [],
      remote: null,
    });
    await handEdit(
      "settings_agent",
      `compaction_method_order = '["soft", "bogus", "remote", "remote"]'`,
    );
    expect(await repo.getCompactionSettings().then((state) => state.methodOrder)).toEqual([
      "soft",
      "remote",
    ]);
  });

  it("leaves remote ineligible when the remote model is missing or empty", async () => {
    await repo.setCompactionSettings({ methodOrder: ["soft"], remote: null });
    await handEdit("settings_agent", "compaction_remote_provider_id = 'prov-1'");
    expect(await repo.getCompactionSettings().then((state) => state.remote)).toBeNull();
  });
});

describe("settings_agent domain — image source", () => {
  it("reports null while unset, round-trips, and clears with null", async () => {
    expect(await repo.getImageSourceProviderId()).toBeNull();
    await repo.setImageSourceProviderId("prov-1");
    expect(await repo.getImageSourceProviderId()).toBe("prov-1");
    await repo.setImageSourceProviderId(null);
    expect(await repo.getImageSourceProviderId()).toBeNull();
  });
});

describe("settings_agent domain — web search", () => {
  const ENGINES = { searxng: { endpoint: "http://10.0.0.9:8888", safesearch: 1 as const } };
  const META = { brave: { apiKey: true }, searxng: { token: true } };
  const SECRETS = { brave: { apiKey: "brave-secret" }, searxng: { token: "sx-secret" } };

  it("reports the unconfigured half while unset and when only another domain wrote the row", async () => {
    expect(await repo.getWebSearchConfig()).toEqual({
      configured: false,
      decodeError: false,
      chain: [],
      timeoutSeconds: null,
      engines: null,
      secrets: null,
      secretsMeta: null,
    });
    await repo.setPermissionMode("auto");
    expect((await repo.getWebSearchConfig()).configured).toBe(false);
  });

  it("round-trips a secret-free write", async () => {
    await repo.setWebSearchConfig(
      { chain: ["searxng", "public"], timeoutSeconds: 90, engines: ENGINES, secrets: {}, meta: {} },
      undefined,
    );
    expect(await repo.getWebSearchConfig()).toEqual({
      configured: true,
      decodeError: false,
      chain: ["searxng", "public"],
      timeoutSeconds: 90,
      engines: ENGINES,
      secrets: null,
      secretsMeta: {},
    });
  });

  it("refuses a key-bearing write without the master key (never plaintext)", async () => {
    await expect(
      repo.setWebSearchConfig(
        { chain: ["public"], timeoutSeconds: 60, engines: {}, secrets: SECRETS, meta: META },
        undefined,
      ),
    ).rejects.toThrow("master_key_missing");
    expect((await repo.getWebSearchConfig()).configured).toBe(false);
  });

  it("encrypts secrets at rest and decrypts only through the seam", async () => {
    await repo.setWebSearchConfig(
      { chain: ["public"], timeoutSeconds: 60, engines: {}, secrets: SECRETS, meta: META },
      MASTER_KEY,
    );
    const raw = await env.DB_V2.prepare(
      "SELECT web_search_secrets_enc AS enc FROM settings_agent WHERE id = 'agent'",
    ).first<{ enc: string | null }>();
    expect(raw?.enc).not.toBeNull();
    expect(raw?.enc).not.toContain("brave-secret");
    expect(raw?.enc).not.toContain("sx-secret");
    const state = await repo.getWebSearchConfig();
    expect(state.secrets).toEqual(SECRETS);
    expect(state.secretsMeta).toEqual(META);
    expect(state.decodeError).toBe(false);
  });

  it("reads presence-only when the master key is absent at read time", async () => {
    const unarmed = createSettingsRepository(env.DB_V2, undefined);
    await repo.setWebSearchConfig(
      { chain: ["public"], timeoutSeconds: 60, engines: {}, secrets: SECRETS, meta: META },
      MASTER_KEY,
    );
    const state = await unarmed.getWebSearchConfig();
    expect(state.configured).toBe(true);
    expect(state.decodeError).toBe(false);
    expect(state.secrets).toBeNull();
    expect(state.secretsMeta).toEqual(META);
  });

  it("decodes loud: a broken cell marks the row decodeError, never a silent default", async () => {
    await repo.setWebSearchConfig(
      { chain: ["public"], timeoutSeconds: 60, engines: ENGINES, secrets: {}, meta: {} },
      undefined,
    );
    await handEdit("settings_agent", "web_search_chain = 'not-json'");
    let state = await repo.getWebSearchConfig();
    expect(state.decodeError).toBe(true);
    expect(state.chain).toEqual([]);
    await handEdit("settings_agent", `web_search_chain = '["public"]', web_search_engines = '{'`);
    state = await repo.getWebSearchConfig();
    expect(state.decodeError).toBe(true);
    await handEdit(
      "settings_agent",
      `web_search_engines = '{"searxng":{}}', web_search_secrets_enc = 'garbage'`,
    );
    state = await repo.getWebSearchConfig();
    expect(state.decodeError).toBe(true);
    expect(state.secrets).toBeNull();
  });

  it("treats a broken secrets_meta cell as a warning, not a decodeError", async () => {
    await repo.setWebSearchConfig(
      { chain: ["public"], timeoutSeconds: 60, engines: {}, secrets: {}, meta: {} },
      undefined,
    );
    await handEdit("settings_agent", "web_search_secrets_meta = 'not-json'");
    const state = await repo.getWebSearchConfig();
    expect(state.decodeError).toBe(false);
    expect(state.secretsMeta).toBeNull();
  });
});

describe("web search secret helpers", () => {
  it("webSearchHasSecrets mirrors the presence fields the encoder gates on", () => {
    expect(webSearchHasSecrets({})).toBe(false);
    expect(webSearchHasSecrets({ brave: { apiKey: "k" } })).toBe(true);
    expect(webSearchHasSecrets({ exa: { apiKey: "k" } })).toBe(true);
    expect(webSearchHasSecrets({ searxng: { basicUsername: "u" } })).toBe(true);
    expect(webSearchHasSecrets({ searxng: { basicPassword: "p" } })).toBe(true);
    expect(webSearchHasSecrets({ searxng: {} })).toBe(false);
  });
});
