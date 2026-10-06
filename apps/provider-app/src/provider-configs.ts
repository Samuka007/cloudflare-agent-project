/**
 * #362 the D1 provider-config overlay loader — the user-face configuration
 * 正本 (provider_configs table). The env MODEL_RELAY_CATALOG /
 * MODEL_RELAY_PROVIDER_CREDENTIALS pair is the deployment seed: the D1 rows
 * are the user-face 正本, merged OVER the env declaration (same id → D1
 * wins), and dispatch merges the DECRYPTED row keys over the env credential
 * slots. #434: the CRUD display face lists ONLY these user rows — the env
 * seed's read faces are the projections/execution-options faces.
 *
 * Discipline carried from #350/#266:
 * - Bad rows are skipped WITH a warning — never silently deleted. The row
 *   stays in D1 and on the GET /system/providers face (status: "warning");
 *   only the effective catalog drops it.
 * - The catalog half of the loader never returns credential material; the
 *   decrypting half is consumed only by dispatch isolates (agent DO
 *   refresh, manager) and the test-connection route, which decrypt per row
 *   with the PROVIDER_CONFIG_MASTER_KEY secret.
 * - The fingerprint is content-only (secret PRESENCE, never values) so
 *   callers can gate hot-reload registration without leaking keys to logs.
 */

import {
  IMAGE_SOURCE_API_FAMILY,
  relayApiValues,
  relayCatalogModelSchema,
  type RelayCatalogProvider,
} from "@cap/agent-do";
import { decryptProviderSecret } from "./provider-config-crypto.js";
import type { RelayProviderCredentialMap } from "./relay-registry.js";

/** The env slice this loader reads (structural — the worker Env satisfies it). */
export interface ProviderConfigEnv {
  DB?: D1Database;
  PROVIDER_CONFIG_MASTER_KEY?: string;
}

/** One decoded provider row as the CRUD face returns it (zero-secret). */
export interface ProviderConfigRecord {
  id: string;
  displayName: string | null;
  baseUrl: string | null;
  api: string | null;
  serviceTier: boolean;
  /** The RAW models JSON value — invalid rows stay visible for repair. */
  models: unknown;
  hasApiKey: boolean;
  /** "ok" when the row decoded clean; "warning" names what was skipped. */
  status: "ok" | "warning";
  warnings: string[];
  /** False while the row declares no models (not in the effective catalog). */
  dispatchable: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The catalog half: validated rows + content fingerprint. */
export interface ProviderConfigCatalogOverlay {
  providers: Record<string, RelayCatalogProvider>;
  /** Content fingerprint (no secret values) for hot-reload gating. */
  fingerprint: string;
}

export interface ProviderConfigFullOverlay extends ProviderConfigCatalogOverlay {
  /** CRUD-face rows (status + warnings included), aligned with `providers`. */
  rows: ProviderConfigRecord[];
  credentials: RelayProviderCredentialMap;
}

interface ProviderConfigDbRow {
  id: string;
  display_name: string | null;
  base_url: string | null;
  api: string | null;
  service_tier: number | null;
  api_key_enc: string | null;
  models: string | null;
  created_at: number;
  updated_at: number;
}

const PROVIDER_CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Type guard: the provider-level api seat admits the #361 relay families +
 * #362's image-source family; anything else is a loud row warning, never a
 * silent entry into the effective catalog (skip-with-warning discipline). */
function isAdmittedProviderApi(
  value: string,
): value is Exclude<RelayCatalogProvider["api"], undefined> {
  return value === IMAGE_SOURCE_API_FAMILY || relayApiValues.some((family) => family === value);
}

/** Provider-id rule shared by the CRUD routes and the loader. */
export function isValidProviderConfigId(id: string): boolean {
  return PROVIDER_CONFIG_ID_PATTERN.test(id) && id.length <= 64;
}

function skipWarning(id: string, reason: string): string {
  return `provider config "${id}": ${reason} — skipped (row kept, never silently deleted)`;
}

/** The full load: CRUD-face rows + overlay halves + the warning transcript. */
export interface ProviderConfigLoad {
  rows: ProviderConfigRecord[];
  catalog: ProviderConfigCatalogOverlay;
  credentials: RelayProviderCredentialMap;
  warnings: string[];
}

/**
 * Read + decode every provider_configs row. `decrypt` controls whether
 * api_key_enc columns are decrypted into the credential half (dispatch
 * isolates and the CRUD face) or merely probed for presence (pure catalog
 * faces — zero-secret by construction).
 */
async function readProviderConfigs(
  env: ProviderConfigEnv,
  options: { decrypt: boolean },
): Promise<ProviderConfigLoad | null> {
  const db = env.DB;
  if (db === undefined) return null;
  const result = await db
    .prepare(
      "SELECT id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at FROM provider_configs ORDER BY id",
    )
    .all<ProviderConfigDbRow>();
  const rows: ProviderConfigRecord[] = [];
  const providers: Record<string, RelayCatalogProvider> = {};
  const credentials: RelayProviderCredentialMap = {};
  const warnings: string[] = [];
  let maxUpdatedAt = 0;
  for (const row of result.results) {
    maxUpdatedAt = Math.max(maxUpdatedAt, row.updated_at);
    const rowWarnings: string[] = [];
    let models: unknown = [];
    let jsonBroken = false;
    if (typeof row.models === "string" && row.models.trim() !== "") {
      try {
        models = JSON.parse(row.models);
      } catch (error) {
        // The raw column value rides the row (one-element wrapper on the
        // CRUD face) so the panel sees exactly what to repair — the warning
        // alone would leave an unactionable bad row.
        models = row.models;
        rowWarnings.push(
          skipWarning(
            row.id,
            `models is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
          ),
        );
        jsonBroken = true;
      }
    }
    let decodedModels: RelayCatalogProvider["models"] = [];
    if (!jsonBroken) {
      const parsed = relayCatalogModelSchema.array().safeParse(models);
      if (parsed.success) {
        decodedModels = parsed.data;
      } else {
        rowWarnings.push(
          skipWarning(
            row.id,
            `models failed the catalog schema (${parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")})`,
          ),
        );
      }
    }
    if (options.decrypt && row.api_key_enc !== null) {
      if (env.PROVIDER_CONFIG_MASTER_KEY === undefined || env.PROVIDER_CONFIG_MASTER_KEY === "") {
        rowWarnings.push(
          skipWarning(
            row.id,
            "api_key_enc present but PROVIDER_CONFIG_MASTER_KEY is not configured",
          ),
        );
      } else {
        try {
          credentials[row.id] = {
            apiKey: await decryptProviderSecret(env.PROVIDER_CONFIG_MASTER_KEY, row.api_key_enc),
            ...(row.base_url !== null && row.base_url !== "" ? { baseUrl: row.base_url } : {}),
          };
        } catch (error) {
          rowWarnings.push(
            skipWarning(
              row.id,
              `api_key_enc is not decryptable (${error instanceof Error ? error.message : String(error)})`,
            ),
          );
        }
      }
    }
    // A valid row with zero models is kept on the CRUD face but dropped
    // from the effective catalog: a provider with no rows would make the
    // selection resolver's "declared providers" vocabulary lie.
    const dispatchable = decodedModels.length > 0;
    if (!dispatchable && rowWarnings.length === 0) {
      rowWarnings.push(
        skipWarning(row.id, "declares no models — not dispatchable until a model is added"),
      );
    }
    const declaredApi = row.api !== null && row.api !== "" ? row.api : null;
    if (declaredApi !== null && !isAdmittedProviderApi(declaredApi)) {
      rowWarnings.push(
        skipWarning(
          row.id,
          `api "${declaredApi}" is not a known family (${[...relayApiValues, IMAGE_SOURCE_API_FAMILY].join(", ")}) — skipped`,
        ),
      );
    }
    if (dispatchable && (declaredApi === null || isAdmittedProviderApi(declaredApi))) {
      providers[row.id] = {
        ...(row.display_name !== null ? { displayName: row.display_name } : {}),
        ...(row.base_url !== null && row.base_url !== "" ? { baseUrl: row.base_url } : {}),
        ...(declaredApi !== null ? { api: declaredApi } : {}),
        ...(row.service_tier === 1 ? { serviceTier: true } : {}),
        models: decodedModels,
      };
    }
    warnings.push(...rowWarnings);
    rows.push({
      id: row.id,
      displayName: row.display_name,
      baseUrl: row.base_url,
      api: row.api,
      serviceTier: row.service_tier === 1,
      // The contract face is an array; a row whose models column never
      // parsed keeps its raw value visible inside a one-element wrapper.
      models: Array.isArray(models) ? models : [models],
      hasApiKey: row.api_key_enc !== null,
      status: rowWarnings.length > 0 ? "warning" : "ok",
      warnings: rowWarnings,
      dispatchable,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  const fingerprint = await fingerprintOf(providers, credentials, maxUpdatedAt);
  return { rows, catalog: { providers, fingerprint }, credentials, warnings };
}

/**
 * Content-only fingerprint: provider declarations in full, credential
 * PRESENCE per id, and the newest updated_at (so a key-only rotation still
 * bumps it). Values of secrets never enter the string.
 */
async function fingerprintOf(
  providers: Record<string, RelayCatalogProvider>,
  credentials: RelayProviderCredentialMap,
  maxUpdatedAt: number,
): Promise<string> {
  const content = JSON.stringify({
    providers,
    credentialPresence: Object.fromEntries(
      Object.entries(credentials).map(([id, slot]) => [id, slot.apiKey !== undefined]),
    ),
    maxUpdatedAt,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += byte.toString(16).padStart(2, "0");
  return binary;
}

/**
 * The catalog-face half (execution-options / projections / selection
 * validation): validated overlay providers + fingerprint, no secrets.
 * Warnings are logged here — the loud half of skip-with-warning (the panel
 * half is the rows' status on GET /system/providers).
 */
export async function loadProviderConfigCatalogOverlay(
  env: ProviderConfigEnv,
): Promise<ProviderConfigCatalogOverlay | null> {
  const load = await readProviderConfigs(env, { decrypt: false });
  if (load === null) return null;
  for (const warning of load.warnings) console.warn(`[provider-configs] ${warning}`);
  return load.catalog;
}

/**
 * The dispatch half (agent DO refresh, manager registration, test-connection):
 * validated overlay + DECRYPTED per-row credential slots. Consumers apply it
 * through RelayProviderRegistry.applyOverlay; standalone semantics (no
 * deployment-slot fallback) are the registry's, keyed on overlay membership.
 */
export async function loadProviderConfigOverlay(
  env: ProviderConfigEnv,
): Promise<(ProviderConfigFullOverlay & { standaloneProviders: ReadonlySet<string> }) | null> {
  const load = await readProviderConfigs(env, { decrypt: true });
  if (load === null) return null;
  for (const warning of load.warnings) console.warn(`[provider-configs] ${warning}`);
  return {
    ...load.catalog,
    rows: load.rows,
    credentials: load.credentials,
    standaloneProviders: new Set(Object.keys(load.catalog.providers)),
  };
}
