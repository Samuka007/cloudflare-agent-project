/**
 * Settings aggregate repository (#596, W6 db campaign T4).
 *
 * The nine legacy single-row seat tables (app_settings / app_theme /
 * system_experiments / web_search / tool_capabilities / origin_allowlist /
 * permission_mode / compaction_settings / image_source) collapse into
 * `settings_app` (request-path domain) + `settings_agent` (turn/dispatch
 * domain) + `system_experiments` (open k/v, per the #591 ruling) — see
 * src/db/schema.ts. This module is the deep seam over those three tables:
 * drizzle lives inside the factory, the interface is the test surface, and
 * callers never see SQL or query builders (#595 lane establishes the same
 * shape for the five core aggregates).
 *
 * Semantics are the legacy `src/db/{settings,web-search,tool-capabilities,
 * origin-allowlist,permission-mode,compaction-settings,image-source}.ts`
 * modules verbatim (the compat suites pin them as the behavior oracle):
 *
 * - Absent row (or absent domain column) = the domain's unconfigured
 *   posture, one for one with the legacy absent-seat semantics. The rows are
 *   created lazily by the first write; a domain write touches ONLY its own
 *   columns, so writing one domain never clobbers another.
 * - Decrypt/encrypt never crosses this seam: web-search secrets go in as
 *   plaintext write fields, come out decrypted (or marked broken); the
 *   ciphertext columns are storage detail.
 * - Corrupt JSON cells ride the skip-with-warning discipline (decode to the
 *   domain's empty value, log, never throw) except where the legacy faces
 *   rule otherwise: origin_allowlist is fail-closed (garbage never widens
 *   the gate) and the web-search row decodes loud (decodeError) so no
 *   default chain is silently substituted.
 *
 * The legacy modules themselves stay untouched until the contract-retirement
 * ticket (#601) deletes them with the old tables; this repository serves the
 * drizzle-era database (DB_V2) beside them.
 */

import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
  encryptProviderSecret,
  decryptProviderSecret,
  type WebSearchSecretsMeta,
  type WebSearchStoredEngines,
  type WebSearchStoredSecrets,
} from "@cap/provider-app";
import {
  compactModeSchema,
  resolveCompactionMethodOrder,
  type CompactMode,
} from "@cap/agent-config";
import { defaultAppSettings, type AppSettings } from "../../contract/domain/app-settings";
import {
  defaultExperiments,
  experimentsSchema,
  type Experiments,
} from "../../contract/domain/experiments";
import type { AppKeybindingOverrides } from "../../contract/domain/app-keybindings";
import { parseOriginLike } from "../../contract/domain/origin-allowlist";
import { permissionModeValues, type PermissionMode } from "../../contract/domain/shared-types";
import { settingsAgent, settingsApp, systemExperiments } from "../schema";

const APP_ROW_ID = "app";
const AGENT_ROW_ID = "agent";

// ─── Faces ───────────────────────────────────────────────────────────────────

/** The stored theme selection (`app_theme` legacy face). */
export interface StoredAppearance {
  themeId: string;
  faviconColor: string | null;
}

/** The read shape of the permission-mode domain (legacy parity). */
export interface PermissionModeState {
  mode: PermissionMode;
  /** True when a stored value exists (false = the absent-seat "full" default). */
  configured: boolean;
}

/** The ruled absent-seat posture (the retired env scalar's default). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "full";

/** The read shape of the tool-capabilities domain (legacy parity). */
export interface ToolCapabilitiesState {
  /** True when any stored gate value exists (false = the absent omp posture). */
  configured: boolean;
  externalThinking: boolean;
  contextNotes: boolean;
  checkpoint: boolean;
}

/** The configured remote summarizer (omp RemoteCompactionConfig analog). */
export interface RemoteCompactionSelection {
  providerId?: string;
  model: string;
}

/** The read shape of the compaction domain (legacy parity). */
export interface CompactionSettingsState {
  /** True when a stored order exists (false = the absent-seat posture). */
  configured: boolean;
  methodOrder: CompactMode[];
  remote: RemoteCompactionSelection | null;
}

/**
 * The absent-seat posture: the #309 status quo (soft — the compact button's
 * shipped semantics), remote ineligible. An operator writes the omp canonical
 * order in to opt in; a fresh deployment never silently swaps its manual
 * compact face to a snapshot cut. Exported for the route faces that prefill
 * the PUT form from the absent state (legacy module parity).
 */
export function absentCompactionSettings(): CompactionSettingsState {
  return { configured: false, methodOrder: ["soft"], remote: null };
}

/** The full next state after a web-search PUT (all fields already merged). */
export interface WebSearchWriteFields {
  chain: string[];
  timeoutSeconds: number;
  engines: WebSearchStoredEngines;
  secrets: WebSearchStoredSecrets;
  meta: WebSearchSecretsMeta;
}

/** True when at least one web-search secret field is set (ciphertext required). */
export function webSearchHasSecrets(secrets: WebSearchStoredSecrets): boolean {
  return (
    secrets.brave?.apiKey !== undefined ||
    secrets.exa?.apiKey !== undefined ||
    secrets.searxng?.token !== undefined ||
    secrets.searxng?.basicUsername !== undefined ||
    secrets.searxng?.basicPassword !== undefined
  );
}

/**
 * The decoded read shape of the web-search half. `configured: false` is the
 * absent half (ruled defaults are resolved by the caller through
 * provider-app's resolveWebSearchConfig — this seam invents no defaults).
 * `decodeError: true` is the loud broken-row posture: no chain is served.
 */
export interface WebSearchConfigState {
  configured: boolean;
  decodeError: boolean;
  chain: string[];
  timeoutSeconds: number | null;
  engines: WebSearchStoredEngines | null;
  secrets: WebSearchStoredSecrets | null;
  secretsMeta: WebSearchSecretsMeta | null;
}

/** The three-gate write shape (@cap/agent-config ExperimentalToolConfig). */
export interface ExperimentalToolConfigLike {
  externalThinking: boolean;
  contextNotes: boolean;
  checkpoint: boolean;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * One seam over settings_app + settings_agent + system_experiments, grouped
 * by the domain each method owns. Every getter's absent-row answer is the
 * domain's ruled default posture; every setter is a targeted-column upsert
 * that never disturbs the other domains sharing the row.
 */
export interface SettingsRepository {
  // settings_app — request-path domain (SPA bootstrap + per-request middleware)

  /** The app preferences; defaults when the row has never been written. */
  getAppSettings(): Promise<AppSettings>;
  /** Full-row replace of the preferences face (PUT /settings/general). Keybinding overrides are preserved. */
  setAppSettings(settings: AppSettings): Promise<void>;
  /** The keybinding overrides; [] on absent row or corrupt cell. */
  getKeybindingOverrides(): Promise<AppKeybindingOverrides>;
  /** Replace the keybinding overrides (targeted column). */
  setKeybindingOverrides(overrides: AppKeybindingOverrides): Promise<void>;
  /** The stored theme selection; null when unset. */
  getStoredAppearance(): Promise<StoredAppearance | null>;
  /** Replace the theme selection (targeted columns). */
  setStoredAppearance(appearance: StoredAppearance): Promise<void>;
  /** The trusted extra browser origins (canonical, fail-closed decode). */
  getOriginAllowlist(): Promise<ReadonlySet<string>>;
  /** Replace the extra-origin seat (canonical origins). */
  setOriginAllowlist(origins: string[]): Promise<void>;

  // system_experiments — open k/v domain

  /** Stored toggles merged over the defaults, schema-parsed. */
  getExperiments(): Promise<Experiments>;
  /** Persist every key (batch upsert — legacy setExperiments parity). */
  setExperiments(experiments: Experiments): Promise<void>;

  // settings_agent — turn/dispatch domain

  /** The session permission posture; absent-seat = "full". */
  getPermissionMode(): Promise<PermissionModeState>;
  /** Replace the posture (targeted column). */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** The three #150 tool gates; absent-seat = all off. */
  getToolCapabilities(): Promise<ToolCapabilitiesState>;
  /** Wholesale replace of the three gates. */
  setToolCapabilities(capabilities: ExperimentalToolConfigLike): Promise<void>;
  /** The compact preference order + remote summarizer; absent-seat = soft-only. */
  getCompactionSettings(): Promise<CompactionSettingsState>;
  /** Wholesale replace (order round-trips the mode schema). */
  setCompactionSettings(settings: {
    methodOrder: CompactMode[];
    remote: RemoteCompactionSelection | null;
  }): Promise<void>;
  /** The generate_image provider selection; null = not configured. */
  getImageSourceProviderId(): Promise<string | null>;
  /** Upsert the selection (null clears it). */
  setImageSourceProviderId(providerId: string | null): Promise<void>;
  /**
   * The RAW stored web-search cells (the agent-snapshot feed, #600 wiring):
   * chain/engines/secrets stay unparsed ciphertext-bearing text — the
   * provider-app loader owns decode/decrypt byte-identically. Null = the
   * absent-seat ruled defaults. The decoded state lives in
   * {@link getWebSearchConfig}.
   */
  getWebSearchRaw(): Promise<{
    chain: string;
    timeoutSeconds: number | null;
    engines: string | null;
    secretsEnc: string | null;
    secretsMeta: string | null;
    updatedAt: number;
  } | null>;
  /**
   * The decoded web-search half; `configured: false` when unwritten,
   * `decodeError: true` when a stored cell failed decode/decrypt.
   */
  getWebSearchConfig(): Promise<WebSearchConfigState>;
  /** Upsert the web-search half. Requires the master key when secrets are present. */
  setWebSearchConfig(fields: WebSearchWriteFields, masterKey: string | undefined): Promise<void>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/** Decode the stored origin cell into the trusted set; garbage never widens the gate. */
function decodeOriginAllowlistCell(raw: string | null): ReadonlySet<string> {
  if (raw === null || raw.trim() === "") {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[origin-allowlist] seat cell is not JSON — treating as empty (${String(error)})`);
    return new Set();
  }
  if (!Array.isArray(parsed)) {
    console.warn("[origin-allowlist] seat cell is not a JSON array — treating as empty");
    return new Set();
  }
  const origins = new Set<string>();
  for (const entry of parsed) {
    const url = typeof entry === "string" ? parseOriginLike(entry) : null;
    if (url === null) {
      console.warn(`[origin-allowlist] dropping non-origin seat entry: ${JSON.stringify(entry)}`);
      continue;
    }
    origins.add(url.origin);
  }
  return origins;
}

/**
 * Parse one JSON cell; a broken cell is reported, never silently empty
 * (the provider-app overlay's parseJsonCell parity).
 */
function parseJsonCell(label: string, raw: string | null): unknown {
  if (raw === null || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(
      `web_search config row: ${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

function buildSettingsRepository(
  db: DrizzleD1Database,
  masterKey: string | undefined,
): SettingsRepository {
  // Fresh object per call: the returned state is caller-owned (a shared
  // constant would let one caller's mutation leak into the next read).
  function absentWebSearchState(): WebSearchConfigState {
    return {
      configured: false,
      decodeError: false,
      chain: [],
      timeoutSeconds: null,
      engines: null,
      secrets: null,
      secretsMeta: null,
    };
  }

  async function selectAppRow() {
    const rows = await db.select().from(settingsApp).where(eq(settingsApp.id, APP_ROW_ID)).limit(1);
    return rows[0];
  }

  async function selectAgentRow() {
    const rows = await db
      .select()
      .from(settingsAgent)
      .where(eq(settingsAgent.id, AGENT_ROW_ID))
      .limit(1);
    return rows[0];
  }

  return {
    async getAppSettings(): Promise<AppSettings> {
      const row = await selectAppRow();
      if (row === undefined) {
        return { ...defaultAppSettings };
      }
      return {
        caffeinate: row.caffeinate,
        showKeyboardHints: row.showKeyboardHints,
        steerActiveThreadOnEnter: row.steerActiveThreadOnEnter,
        showUnhandledProviderEvents: row.showUnhandledProviderEvents,
        codexMemoryEnabled: row.codexMemoryEnabled,
        claudeCodeMemoryEnabled: row.claudeCodeMemoryEnabled,
        codexSubagentsDisabled: row.codexSubagentsDisabled,
        claudeCodeSubagentsDisabled: row.claudeCodeSubagentsDisabled,
        claudeCodeWorkflowsDisabled: row.claudeCodeWorkflowsDisabled,
        onboardingCompletedAt: row.onboardingCompletedAt,
      };
    },

    async setAppSettings(settings: AppSettings): Promise<void> {
      // Full-row replace of the preferences face only — the keybinding column
      // is not in this face (legacy COALESCE parity: fresh insert gets the
      // column default '[]', a conflict update never touches it).
      const now = Date.now();
      await db
        .insert(settingsApp)
        .values({
          id: APP_ROW_ID,
          caffeinate: settings.caffeinate,
          showKeyboardHints: settings.showKeyboardHints,
          steerActiveThreadOnEnter: settings.steerActiveThreadOnEnter,
          showUnhandledProviderEvents: settings.showUnhandledProviderEvents,
          codexMemoryEnabled: settings.codexMemoryEnabled,
          claudeCodeMemoryEnabled: settings.claudeCodeMemoryEnabled,
          codexSubagentsDisabled: settings.codexSubagentsDisabled,
          claudeCodeSubagentsDisabled: settings.claudeCodeSubagentsDisabled,
          claudeCodeWorkflowsDisabled: settings.claudeCodeWorkflowsDisabled,
          onboardingCompletedAt: settings.onboardingCompletedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsApp.id,
          set: {
            caffeinate: settings.caffeinate,
            showKeyboardHints: settings.showKeyboardHints,
            steerActiveThreadOnEnter: settings.steerActiveThreadOnEnter,
            showUnhandledProviderEvents: settings.showUnhandledProviderEvents,
            codexMemoryEnabled: settings.codexMemoryEnabled,
            claudeCodeMemoryEnabled: settings.claudeCodeMemoryEnabled,
            codexSubagentsDisabled: settings.codexSubagentsDisabled,
            claudeCodeSubagentsDisabled: settings.claudeCodeSubagentsDisabled,
            claudeCodeWorkflowsDisabled: settings.claudeCodeWorkflowsDisabled,
            onboardingCompletedAt: settings.onboardingCompletedAt,
            updatedAt: now,
          },
        })
        .run();
    },

    async getKeybindingOverrides(): Promise<AppKeybindingOverrides> {
      const row = await selectAppRow();
      if (row === undefined) {
        return [];
      }
      try {
        const parsed: unknown = JSON.parse(row.keybindingOverrides);
        if (!Array.isArray(parsed)) {
          return [];
        }
        return parsed as AppKeybindingOverrides;
      } catch {
        // bb: invalid overrides degrade to [] with an error log.
        console.error("invalid keybinding overrides stored; ignoring");
        return [];
      }
    },

    async setKeybindingOverrides(overrides: AppKeybindingOverrides): Promise<void> {
      const now = Date.now();
      const overridesJson = JSON.stringify(overrides);
      await db
        .insert(settingsApp)
        .values({ id: APP_ROW_ID, keybindingOverrides: overridesJson, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsApp.id,
          set: { keybindingOverrides: overridesJson, updatedAt: now },
        })
        .run();
    },

    async getStoredAppearance(): Promise<StoredAppearance | null> {
      const row = await selectAppRow();
      // Legacy app_theme.theme_id was NOT NULL, so "row present" implied "set".
      // Collapsed, the theme columns are nullable siblings: an unset theme is
      // null regardless of which other domain created the row.
      if (row?.themeId == null) {
        return null;
      }
      return { themeId: row.themeId, faviconColor: row.faviconColor };
    },

    async setStoredAppearance(appearance: StoredAppearance): Promise<void> {
      const now = Date.now();
      await db
        .insert(settingsApp)
        .values({
          id: APP_ROW_ID,
          themeId: appearance.themeId,
          faviconColor: appearance.faviconColor,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsApp.id,
          set: {
            themeId: appearance.themeId,
            faviconColor: appearance.faviconColor,
            updatedAt: now,
          },
        })
        .run();
    },

    async getOriginAllowlist(): Promise<ReadonlySet<string>> {
      const row = await selectAppRow();
      if (row === undefined) {
        return new Set();
      }
      return decodeOriginAllowlistCell(row.originAllowlist);
    },

    async setOriginAllowlist(origins: string[]): Promise<void> {
      const now = Date.now();
      const originsJson = JSON.stringify(origins);
      await db
        .insert(settingsApp)
        .values({ id: APP_ROW_ID, originAllowlist: originsJson, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsApp.id,
          set: { originAllowlist: originsJson, updatedAt: now },
        })
        .run();
    },

    async getExperiments(): Promise<Experiments> {
      const merged: Experiments = { ...defaultExperiments };
      const rows = await db.select().from(systemExperiments);
      for (const row of rows) {
        if (row.key in merged) {
          merged[row.key as keyof Experiments] = row.value !== 0;
        }
      }
      return experimentsSchema.parse(merged);
    },

    async setExperiments(experiments: Experiments): Promise<void> {
      const now = Date.now();
      const statements = (Object.keys(experiments) as (keyof Experiments)[]).map((key) =>
        db
          .insert(systemExperiments)
          .values({ key, value: experiments[key] ? 1 : 0, updatedAt: now })
          .onConflictDoUpdate({
            target: systemExperiments.key,
            set: { value: experiments[key] ? 1 : 0, updatedAt: now },
          }),
      );
      // The experiments face is never empty (the record spans the key
      // registry); the tuple cast satisfies the non-empty batch signature.
      await db.batch(statements as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    },

    async getPermissionMode(): Promise<PermissionModeState> {
      const row = await selectAgentRow();
      if (row === undefined) {
        return { configured: false, mode: DEFAULT_PERMISSION_MODE };
      }
      const raw = row.permissionMode;
      // Column-scoped configured bit (legacy table-presence parity, the
      // web-search/tool-gate halves' discipline): the collapsed row is
      // SHARED with the sibling agent domains — their writes must never
      // report the permission posture as configured (surfaced by the T6
      // re-point; a row-presence key would flip the bit on any sibling
      // write). NULL = the ruled default, never written.
      // Strict vocabulary decode (the #502 seat precedent): a hand-edited
      // value outside the enum is not a posture — it falls back to the ruled
      // default while `configured` stays true (the value IS stored).
      const mode =
        permissionModeValues.find((candidate) => candidate === raw) ?? DEFAULT_PERMISSION_MODE;
      return { configured: raw !== null, mode };
    },

    async setPermissionMode(mode: PermissionMode): Promise<void> {
      // NULL = the ruled default 'full', never written (schema note).
      const now = Date.now();
      await db
        .insert(settingsAgent)
        .values({ id: AGENT_ROW_ID, permissionMode: mode, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsAgent.id,
          set: { permissionMode: mode, updatedAt: now },
        })
        .run();
    },

    async getToolCapabilities(): Promise<ToolCapabilitiesState> {
      const row = await selectAgentRow();
      // All NULL = the unconfigured omp posture (families off). The three
      // gates decode strict-0/1 (drizzle boolean mode: Number(v) === 1), the
      // service_tier precedent — a hand-edited 2 stays off.
      if (row === undefined) {
        return {
          configured: false,
          externalThinking: false,
          contextNotes: false,
          checkpoint: false,
        };
      }
      return {
        configured:
          row.externalThinking !== null || row.contextNotes !== null || row.checkpoint !== null,
        externalThinking: row.externalThinking === true,
        contextNotes: row.contextNotes === true,
        checkpoint: row.checkpoint === true,
      };
    },

    async setToolCapabilities(capabilities: ExperimentalToolConfigLike): Promise<void> {
      const now = Date.now();
      await db
        .insert(settingsAgent)
        .values({
          id: AGENT_ROW_ID,
          externalThinking: capabilities.externalThinking,
          contextNotes: capabilities.contextNotes,
          checkpoint: capabilities.checkpoint,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsAgent.id,
          set: {
            externalThinking: capabilities.externalThinking,
            contextNotes: capabilities.contextNotes,
            checkpoint: capabilities.checkpoint,
            updatedAt: now,
          },
        })
        .run();
    },

    async getCompactionSettings(): Promise<CompactionSettingsState> {
      const row = await selectAgentRow();
      // The seat is operator input re-decoded at every read: a hand-edited
      // method_order filters/dedupes through the omp resolution (never
      // throws); a remote_model that vanished leaves remote ineligible
      // rather than poisoning the whole row.
      if (row?.compactionMethodOrder == null) {
        return absentCompactionSettings();
      }
      let parsedOrder: unknown = [];
      try {
        parsedOrder = JSON.parse(row.compactionMethodOrder) as unknown;
      } catch {
        parsedOrder = [];
      }
      const remoteModel = row.compactionRemoteModel;
      const remoteProviderId = row.compactionRemoteProviderId;
      const remote =
        remoteModel !== null && remoteModel !== ""
          ? {
              ...(remoteProviderId !== null && remoteProviderId !== ""
                ? { providerId: remoteProviderId }
                : {}),
              model: remoteModel,
            }
          : null;
      return {
        configured: true,
        methodOrder: resolveCompactionMethodOrder(parsedOrder),
        remote,
      };
    },

    async setCompactionSettings(settings: {
      methodOrder: CompactMode[];
      remote: RemoteCompactionSelection | null;
    }): Promise<void> {
      // Round-trip through the mode schema so the stored JSON is the
      // vocabulary, not the caller's spelling.
      const now = Date.now();
      const order = settings.methodOrder.map((mode) => compactModeSchema.parse(mode));
      const orderJson = JSON.stringify(order);
      const remoteProviderId = settings.remote?.providerId ?? null;
      const remoteModel = settings.remote?.model ?? null;
      await db
        .insert(settingsAgent)
        .values({
          id: AGENT_ROW_ID,
          compactionMethodOrder: orderJson,
          compactionRemoteProviderId: remoteProviderId,
          compactionRemoteModel: remoteModel,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsAgent.id,
          set: {
            compactionMethodOrder: orderJson,
            compactionRemoteProviderId: remoteProviderId,
            compactionRemoteModel: remoteModel,
            updatedAt: now,
          },
        })
        .run();
    },

    async getImageSourceProviderId(): Promise<string | null> {
      const row = await selectAgentRow();
      return row?.imageSourceProviderId ?? null;
    },

    async getWebSearchRaw() {
      const row = await selectAgentRow();
      if (row?.webSearchChain == null) return null;
      return {
        chain: row.webSearchChain,
        timeoutSeconds: row.webSearchTimeoutSeconds,
        engines: row.webSearchEngines,
        secretsEnc: row.webSearchSecretsEnc,
        secretsMeta: row.webSearchSecretsMeta,
        updatedAt: row.updatedAt,
      };
    },

    async setImageSourceProviderId(providerId: string | null): Promise<void> {
      const now = Date.now();
      await db
        .insert(settingsAgent)
        .values({ id: AGENT_ROW_ID, imageSourceProviderId: providerId, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsAgent.id,
          set: { imageSourceProviderId: providerId, updatedAt: now },
        })
        .run();
    },

    async getWebSearchConfig(): Promise<WebSearchConfigState> {
      const row = await selectAgentRow();
      // The half is configured when its anchor cell exists — a row written
      // for another domain only never configured the web-search half.
      if (row?.webSearchChain == null) {
        return absentWebSearchState();
      }
      const state: WebSearchConfigState = {
        configured: true,
        decodeError: false,
        chain: [],
        timeoutSeconds: row.webSearchTimeoutSeconds,
        engines: null,
        secrets: null,
        secretsMeta: null,
      };
      // Decode half of the provider-app overlay's assembleWebSearch: JSON
      // cells parse with the skip-with-warning discipline, but a broken
      // chain/engines/secrets marks the row loud (decodeError) so no default
      // chain is silently substituted. Validation itself stays in
      // resolveWebSearchConfig (provider-app owns the assembly).
      const parsedChain = parseJsonCell("chain", row.webSearchChain);
      if (parsedChain === undefined || !Array.isArray(parsedChain)) {
        state.decodeError = true;
        return state;
      }
      state.chain = parsedChain as string[];
      const parsedEngines = parseJsonCell("engines", row.webSearchEngines);
      if (
        row.webSearchEngines !== null &&
        (parsedEngines === null || typeof parsedEngines !== "object")
      ) {
        state.decodeError = true;
        return state;
      }
      state.engines = parsedEngines ?? null;
      const parsedMeta = parseJsonCell("secrets_meta", row.webSearchSecretsMeta);
      state.secretsMeta = parsedMeta ?? null;
      if (row.webSearchSecretsEnc !== null) {
        if (masterKey === undefined || masterKey === "") {
          console.warn(
            "web_search config row: secrets_enc present but PROVIDER_CONFIG_MASTER_KEY is not configured — engines needing secrets will report unconfigured",
          );
        } else {
          try {
            state.secrets = JSON.parse(
              await decryptProviderSecret(masterKey, row.webSearchSecretsEnc),
            ) as WebSearchStoredSecrets;
          } catch (error) {
            console.warn(
              `web_search config row: secrets_enc is not decryptable (${error instanceof Error ? error.message : String(error)}) — decodeError (row kept, no chain served)`,
            );
            state.decodeError = true;
            return state;
          }
        }
      }
      return state;
    },

    async setWebSearchConfig(
      fields: WebSearchWriteFields,
      writeKey: string | undefined,
    ): Promise<void> {
      // DB-layer backstop (the provider_configs encrypted-credential rule): a
      // key-bearing write without the master secret is refused, never stored
      // in plaintext. The route pre-checks with the ApiError vocabulary; this
      // guards direct repository callers.
      let ciphertext: string | null = null;
      if (webSearchHasSecrets(fields.secrets)) {
        if (writeKey === undefined || writeKey === "") {
          throw new Error("master_key_missing");
        }
        ciphertext = await encryptProviderSecret(writeKey, JSON.stringify(fields.secrets));
      }
      const now = Date.now();
      const chainJson = JSON.stringify(fields.chain);
      const enginesJson = JSON.stringify(fields.engines);
      const metaJson = JSON.stringify(fields.meta);
      await db
        .insert(settingsAgent)
        .values({
          id: AGENT_ROW_ID,
          webSearchChain: chainJson,
          webSearchTimeoutSeconds: fields.timeoutSeconds,
          webSearchEngines: enginesJson,
          webSearchSecretsEnc: ciphertext,
          webSearchSecretsMeta: metaJson,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settingsAgent.id,
          set: {
            webSearchChain: chainJson,
            webSearchTimeoutSeconds: fields.timeoutSeconds,
            webSearchEngines: enginesJson,
            webSearchSecretsEnc: ciphertext,
            webSearchSecretsMeta: metaJson,
            updatedAt: now,
          },
        })
        .run();
    },
  };
}

/**
 * The factory: drizzle stays inside; callers get the interface only.
 * `masterKey` arms the web-search secret half (encrypt on write, decrypt on
 * read) — the PROVIDER_CONFIG_MASTER_KEY secret, exactly like the legacy
 * seat module took it.
 */
export function createSettingsRepository(db: D1Database, masterKey?: string): SettingsRepository {
  return buildSettingsRepository(drizzle(db), masterKey);
}
