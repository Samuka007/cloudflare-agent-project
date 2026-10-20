/**
 * #362/#450 the D1 provider-config overlay loader — the user-face
 * configuration 正本 (provider_configs table) and the ONLY directory source
 * (#450: the env MODEL_RELAY_CATALOG / MODEL_RELAY_PROVIDER_CREDENTIALS
 * seeds are deleted; there is no env branch anywhere on the provider path).
 * #434: the CRUD display face lists ONLY these user rows; the read faces
 * (execution-options / projections) project the same rows.
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
  DEFAULT_EXPERIMENTAL_TOOL_CONFIG,
  DEFAULT_WEB_SEARCH_CONFIG,
  IMAGE_SOURCE_API_FAMILY,
  isImageGenerationModelId,
  projectWebSearchConfig,
  relayApiValues,
  relayCatalogModelSchema,
  relayImageModelKeys,
  relayImageModelSchema,
  resolveWebSearchConfig,
  type RelayCatalogModel,
  type ExperimentalToolConfig,
  type RelayCatalogProvider,
  type RelayImageModel,
  type ProviderModelFamily,
  type WebSearchConfig,
  type WebSearchProjection,
} from "@cap/agent-config";
import { decryptProviderSecret } from "./provider-config-crypto";

/** One provider's decrypted credential slot (never a face). */
export interface RelayProviderCredential {
  apiKey?: string;
  baseUrl?: string;
}

export type RelayProviderCredentialMap = Record<string, RelayProviderCredential>;

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
  /**
   * #448 the explicit generate_image source seat: the provider id the panel
   * selected (D1 image_source), or null when nothing is selected — which is
   * the ONLY not-configured state (#450: zero env fallback). May dangle when
   * the selected row was deleted afterwards; the read faces report it and
   * the executor answers honestly.
   */
  imageSourceProviderId: string | null;
  /**
   * #449 the web_search engine-chain half: secret-free projection of the D1
   * `web_search` row (the sole 正本 — the AGENT_DO_WEB_SEARCH env path is
   * deleted). Absent row = ruled defaults (configured:false); a broken row
   * is a loud decodeError, never a silent default.
   */
  webSearch: WebSearchOverlayRow;
  /**
   * #502 the experimental tool-capability half: the D1 `tool_capabilities`
   * single-row seat (the sole 正本 — the three AGENT_DO_* env gates are
   * deleted). Absent row = the omp posture (configured:false, all gates
   * off); the values gate think / context_notes+new_context /
   * checkpoint+rewind on the wire.
   */
  toolCapabilities: ToolCapabilitiesOverlayRow;
  /** Content fingerprint (no secret values) for hot-reload gating. */
  fingerprint: string;
}

/** The secret-free overlay half of the #502 tool_capabilities row. */
export interface ToolCapabilitiesOverlayRow extends ExperimentalToolConfig {
  /** True when a D1 row exists (false = absent-row omp posture, all off). */
  configured: boolean;
}

export interface ProviderConfigFullOverlay extends ProviderConfigCatalogOverlay {
  /** CRUD-face rows (status + warnings included), aligned with `providers`. */
  rows: ProviderConfigRecord[];
  credentials: RelayProviderCredentialMap;
  /**
   * #449 the dispatch half: the full engine config with DECRYPTED secrets
   * merged (agent DO hot-apply). null when no row exists or the row is
   * broken (the DO keeps its last-known config; the read face is loud).
   */
  webSearchConfig: WebSearchConfig | null;
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

/** The #449 web_search row (single-row seat, the image_source precedent). */
interface WebSearchDbRow {
  id: string;
  /** JSON array of engine ids, in chain order. */
  chain: string;
  timeout_seconds: number | null;
  /** JSON non-secret engine settings (searxng endpoint/categories/…). */
  engines: string | null;
  /** AES-GCM JSON of the secret half (brave apiKey, searxng token/basic*). */
  secrets_enc: string | null;
  /** JSON secret-PRESENCE map — the no-decrypt faces read presence only. */
  secrets_meta: string | null;
  updated_at: number;
}

/** The #502 tool_capabilities row (single-row seat, same precedent). */
interface ToolCapabilitiesDbRow {
  id: string;
  /** 0/1 gates (#150): think / context_notes+new_context / checkpoint+rewind. */
  external_thinking: number | null;
  context_notes: number | null;
  checkpoint: number | null;
  updated_at: number;
}

/** Non-secret engine settings as stored (plaintext `engines` column). */
export interface WebSearchStoredEngines {
  searxng?: {
    endpoint?: string;
    categories?: string;
    language?: string;
    safesearch?: 0 | 1 | 2;
  };
}

/** Secret engine settings as stored (the AES-GCM `secrets_enc` payload). */
export interface WebSearchStoredSecrets {
  brave?: { apiKey?: string };
  exa?: { apiKey?: string };
  searxng?: { token?: string; basicUsername?: string; basicPassword?: string };
}

/** Secret-PRESENCE map as stored (plaintext `secrets_meta` column). */
export interface WebSearchSecretsMeta {
  brave?: { apiKey?: boolean };
  exa?: { apiKey?: boolean };
  searxng?: { token?: boolean; basic?: boolean };
}

/** The secret-free overlay half of the web_search row (#449). */
export interface WebSearchOverlayRow {
  /** True when a D1 row exists (false = ruled defaults, not a fallback). */
  configured: boolean;
  /** True when the stored row failed decode/decrypt — no chain is served. */
  decodeError: boolean;
  /** Secret-free projection; null when absent or broken. */
  projection: WebSearchProjection | null;
  /**
   * Zero-secret editable engine detail (the PUT face prefills the non-secret
   * values and shows secret PRESENCE only); null when absent or broken.
   */
  engines: WebSearchFaceEngines | null;
}

/** Zero-secret engine detail for the panel write face (#449). */
export interface WebSearchFaceEngines {
  brave: { hasApiKey: boolean };
  exa: { hasApiKey: boolean };
  searxng: {
    endpoint: string | null;
    categories: string | null;
    language: string | null;
    safesearch: 0 | 1 | 2 | null;
    hasToken: boolean;
    hasBasicAuth: boolean;
  };
}

const WEB_SEARCH_ROW_ID = "web_search";
const TOOL_CAPABILITIES_ROW_ID = "tool_capabilities";
const PROVIDER_CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The three halves assembleWebSearch derives from the stored row. */
interface WebSearchAssembly {
  overlay: WebSearchOverlayRow;
  config: WebSearchConfig | null;
  fingerprint: string | null;
}

/** Parse one JSON cell; a broken cell is reported, never silently empty. */
function parseJsonCell(label: string, raw: string | null, warnings: string[]): unknown {
  if (raw === null || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    warnings.push(
      `web_search config row: ${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

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

/**
 * #485 image-row recovery (lenient LOAD half of the family split): a model
 * entry that carries chat seats is decoded by DROPPING those seats with a
 * loud warning — a pre-existing row (e.g. one that went through the
 * discovery-merge era) keeps dispatching instead of silently joining the
 * directory with chat semantics, and the panel shows exactly what to repair.
 * Writes stay strict (the CRUD faces 422 chat seats on image rows), so the
 * leniency exists only for rows already stored.
 */
function recoverImageModelEntry(entry: unknown): { model: RelayImageModel; note: string } | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (relayImageModelKeys.includes(key)) kept[key] = value;
    else dropped.push(key);
  }
  if (dropped.length === 0) return null;
  const parsed = relayImageModelSchema.safeParse(kept);
  if (!parsed.success) return null;
  return {
    model: parsed.data,
    note:
      `model "${parsed.data.id}": chat seat(s) dropped (${dropped.join(", ")}) — ` +
      `image rows carry image semantics only ` +
      `(id/name/description/sizes/outputFormat/cost.perImage); ` +
      `save the row in the panel to persist the cleanup`,
  };
}

/**
 * #485 the family-paired model decode for one stored row. Chat rows keep the
 * existing strict whole-array decode, then EXCLUDE image-generation ids from
 * the effective directory with a loud warning (the chat directory must never
 * serve 产图 models). Image rows decode against the image dictionary: usable
 * entries pass, chat-seat contamination is recovered with per-seat warnings,
 * and an entry that is still unusable skips alone (its siblings keep
 * dispatching) — never a silent drop.
 */
function decodeRowModels(
  id: string,
  family: ProviderModelFamily,
  raw: unknown,
): { models: RelayImageModel[] | RelayCatalogModel[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return {
      models: [],
      warnings: [skipWarning(id, "models is not a list — no model entry decoded")],
    };
  }
  if (family === "chat") {
    const parsed = relayCatalogModelSchema.array().safeParse(raw);
    if (!parsed.success) {
      warnings.push(
        skipWarning(
          id,
          `models failed the catalog schema (${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")})`,
        ),
      );
      return { models: [], warnings };
    }
    const imageIds = parsed.data
      .filter((model) => isImageGenerationModelId(model.id))
      .map((model) => model.id);
    if (imageIds.length > 0) {
      const listed = imageIds.slice(0, 5).join(", ");
      const listedIds =
        imageIds.length > 5 ? `${listed} +${String(imageIds.length - 5)} more` : listed;
      warnings.push(
        skipWarning(
          id,
          `image-generation model id(s) excluded from the chat directory ` +
            `(${listedIds}) — move them to an api=openai-images row and ` +
            `select it in Settings → Providers → Image Source`,
        ),
      );
    }
    return {
      models: parsed.data.filter((model) => !isImageGenerationModelId(model.id)),
      warnings,
    };
  }
  const models: RelayImageModel[] = [];
  for (const entry of raw) {
    const strict = relayImageModelSchema.safeParse(entry);
    if (strict.success) {
      models.push(strict.data);
      continue;
    }
    const recovered = recoverImageModelEntry(entry);
    if (recovered !== null) {
      models.push(recovered.model);
      warnings.push(`provider config "${id}": ${recovered.note}`);
      continue;
    }
    warnings.push(
      skipWarning(
        id,
        `model entry ${JSON.stringify(entry ?? null).slice(0, 80)} is not a usable image model row ` +
          `(${strict.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")})`,
      ),
    );
  }
  return { models, warnings };
}

/** The full load: CRUD-face rows + overlay halves + the warning transcript. */
export interface ProviderConfigLoad {
  rows: ProviderConfigRecord[];
  catalog: ProviderConfigCatalogOverlay;
  credentials: RelayProviderCredentialMap;
  /** #449 the dispatch-half engine config (decrypt half only). */
  webSearchConfig: WebSearchConfig | null;
  warnings: string[];
}

// ─── Seam-neutral assembly core (T6 route faces + this loader share it) ──────

/**
 * One provider_configs row in seam-neutral shape: the worker's repository
 * seam (T6) hands these over WITHOUT ever crossing the api_key_enc
 * ciphertext — credential presence rides `hasCredential`, and the decrypt
 * half re-attaches the ciphertext separately (rowSecrets on the raw load).
 * `models` stays the RAW stored JSON text: a corrupt cell must ride the CRUD
 * face unrepaired (skip-with-warning), so the assembler owns the parse.
 */
export interface ProviderConfigRawRow {
  id: string;
  displayName: string | null;
  baseUrl: string | null;
  api: string | null;
  serviceTier: boolean;
  hasCredential: boolean;
  models: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The decoded `web_search` half as the repository seam hands it over (the
 * JSON cells already parsed, the ciphertext already decrypted or flagged);
 * `decodeError: true` marks the caller's own decode failure — the assembler
 * serves the loud posture without re-warning (the caller owns its message).
 */
export interface WebSearchDecodedHalf {
  configured: boolean;
  decodeError: boolean;
  chain: string[];
  timeoutSeconds: number | null;
  engines: WebSearchStoredEngines | null;
  secrets: WebSearchStoredSecrets | null;
  secretsMeta: WebSearchSecretsMeta | null;
  updatedAt: number;
}

/** Everything the assembler needs, free of any D1 handle (T1: 组装留 provider-app). */
export interface ProviderConfigRawLoad {
  rows: ProviderConfigRawRow[];
  /**
   * Ciphertext by row id — the decrypt half only (this module's D1 loader).
   * The repository-driven route faces omit it: zero ciphertext ever crosses
   * their seam, so `credentials` comes back empty there.
   */
  rowSecrets?: Record<string, string | null>;
  imageSourceProviderId: string | null;
  toolCapabilities: ToolCapabilitiesOverlayRow;
  /** The decoded web-search half; null = the absent-row ruled-default posture. */
  webSearch: WebSearchDecodedHalf | null;
}

/**
 * Assemble the full provider-config load from seam-neutral inputs — the ONE
 * decode home for the row records (skip-with-warning discipline), the
 * effective catalog projection, the web-search halves, and the content
 * fingerprint. The D1 loader below feeds it from the legacy batch; the
 * worker's T6 route faces feed it from the drizzle repositories. Row decode
 * logic is byte-identical for both callers.
 */
export async function assembleProviderConfigLoad(
  raw: ProviderConfigRawLoad,
  options: { decrypt: boolean; masterKey?: string },
  warnings: string[] = [],
): Promise<ProviderConfigLoad> {
  const rows: ProviderConfigRecord[] = [];
  const providers: Record<string, RelayCatalogProvider> = {};
  const credentials: RelayProviderCredentialMap = {};
  let maxUpdatedAt = 0;
  for (const row of raw.rows) {
    maxUpdatedAt = Math.max(maxUpdatedAt, row.updatedAt);
    const ciphertext = raw.rowSecrets?.[row.id] ?? null;
    const decoded = await decodeProviderConfigRow(row, ciphertext, options);
    if (decoded.credential !== undefined) credentials[row.id] = decoded.credential;
    if (decoded.provider !== null) providers[row.id] = decoded.provider;
    rows.push(decoded.record);
    warnings.push(...decoded.warnings);
  }
  const webSearch = assembleDecodedWebSearchHalf(raw.webSearch, options.decrypt, warnings);
  const fingerprint = await fingerprintOf(
    providers,
    credentials,
    maxUpdatedAt,
    raw.imageSourceProviderId,
    webSearch.fingerprint,
    JSON.stringify(raw.toolCapabilities),
  );
  return {
    rows,
    catalog: {
      providers,
      imageSourceProviderId: raw.imageSourceProviderId,
      webSearch: webSearch.overlay,
      toolCapabilities: raw.toolCapabilities,
      fingerprint,
    },
    credentials,
    webSearchConfig: webSearch.config,
    warnings,
  };
}

/**
 * The shared per-row decode: the CRUD-face record (skip-with-warning
 * discipline), the effective-catalog entry, and — decrypt half only — the
 * decrypted credential slot. Byte-identical for the D1 loader and the
 * repository-driven route faces.
 */
async function decodeProviderConfigRow(
  raw: ProviderConfigRawRow,
  ciphertext: string | null,
  options: { decrypt: boolean; masterKey?: string },
): Promise<{
  record: ProviderConfigRecord;
  provider: RelayCatalogProvider | null;
  credential?: RelayProviderCredential;
  warnings: string[];
}> {
  const rowWarnings: string[] = [];
  const declaredApi = raw.api !== null && raw.api !== "" ? raw.api : null;
  // #485: the row-level api seat IS the model family (see decodeRowModels).
  const family: ProviderModelFamily = declaredApi === IMAGE_SOURCE_API_FAMILY ? "image" : "chat";
  let models: unknown = [];
  let jsonBroken = false;
  if (typeof raw.models === "string" && raw.models.trim() !== "") {
    try {
      models = JSON.parse(raw.models);
    } catch (error) {
      // The raw column value rides the row (one-element wrapper on the
      // CRUD face) so the panel sees exactly what to repair — the warning
      // alone would leave an unactionable bad row.
      models = raw.models;
      rowWarnings.push(
        skipWarning(
          raw.id,
          `models is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        ),
      );
      jsonBroken = true;
    }
  }
  let decodedModels: RelayCatalogModel[] | RelayImageModel[] = [];
  if (!jsonBroken) {
    const decoded = decodeRowModels(raw.id, family, models);
    decodedModels = decoded.models;
    rowWarnings.push(...decoded.warnings);
  }
  let credential: RelayProviderCredential | undefined;
  if (options.decrypt && ciphertext !== null) {
    if (options.masterKey === undefined || options.masterKey === "") {
      rowWarnings.push(
        skipWarning(raw.id, "api_key_enc present but PROVIDER_CONFIG_MASTER_KEY is not configured"),
      );
    } else {
      try {
        credential = {
          apiKey: await decryptProviderSecret(options.masterKey, ciphertext),
          ...(raw.baseUrl !== null && raw.baseUrl !== "" ? { baseUrl: raw.baseUrl } : {}),
        };
      } catch (error) {
        rowWarnings.push(
          skipWarning(
            raw.id,
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
      skipWarning(raw.id, "declares no models — not dispatchable until a model is added"),
    );
  }
  if (declaredApi !== null && !isAdmittedProviderApi(declaredApi)) {
    rowWarnings.push(
      skipWarning(
        raw.id,
        `api "${declaredApi}" is not a known family (${[...relayApiValues, IMAGE_SOURCE_API_FAMILY].join(", ")}) — skipped`,
      ),
    );
  }
  let provider: RelayCatalogProvider | null = null;
  if (dispatchable && (declaredApi === null || isAdmittedProviderApi(declaredApi))) {
    const shell = {
      ...(raw.displayName !== null ? { displayName: raw.displayName } : {}),
      ...(raw.baseUrl !== null && raw.baseUrl !== "" ? { baseUrl: raw.baseUrl } : {}),
      ...(raw.serviceTier ? { serviceTier: true } : {}),
    };
    // The decode above resolved the SAME family from the same declaredApi,
    // so each branch's cast is the family pairing re-asserted for the type.
    provider =
      declaredApi === IMAGE_SOURCE_API_FAMILY
        ? { ...shell, api: declaredApi, models: decodedModels as RelayImageModel[] }
        : {
            ...shell,
            ...(declaredApi !== null ? { api: declaredApi } : {}),
            models: decodedModels as RelayCatalogModel[],
          };
  }
  const record: ProviderConfigRecord = {
    id: raw.id,
    displayName: raw.displayName,
    baseUrl: raw.baseUrl,
    api: raw.api,
    serviceTier: raw.serviceTier,
    // The contract face is an array; a row whose models column never
    // parsed keeps its raw value visible inside a one-element wrapper.
    models: Array.isArray(models) ? models : [models],
    hasApiKey: raw.hasCredential,
    status: rowWarnings.length > 0 ? "warning" : "ok",
    warnings: rowWarnings,
    dispatchable,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  return {
    record,
    provider,
    ...(credential !== undefined ? { credential } : {}),
    warnings: rowWarnings,
  };
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
  // #448 the 产图源 seat rides every load so a selection flip hot-applies
  // through the same fingerprint gate as a row edit. ONE batch round trip
  // with the rows read — the turn-boundary refresh awaits this loader, and
  // an extra DO event-loop yield here races the read faces (observed: the
  // L1 send→read tests see a completed mock turn where one round trip sees
  // an in-flight one).
  const [imageSourceResult, rowsResult, webSearchResult, toolCapabilitiesResult] = await db.batch([
    db.prepare("SELECT provider_id FROM image_source WHERE id = 'image_source'"),
    db.prepare(
      "SELECT id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at FROM provider_configs ORDER BY id",
    ),
    db.prepare(
      `SELECT id, chain, timeout_seconds, engines, secrets_enc, secrets_meta, updated_at
       FROM ${WEB_SEARCH_ROW_ID} WHERE id = '${WEB_SEARCH_ROW_ID}'`,
    ),
    // #502 the tool-capability seat rides the same single batch (one round
    // trip — the turn-boundary refresh awaits this loader) so a gate flip
    // hot-applies through the same fingerprint gate as a row edit.
    db.prepare(
      `SELECT id, external_thinking, context_notes, checkpoint, updated_at
       FROM ${TOOL_CAPABILITIES_ROW_ID} WHERE id = '${TOOL_CAPABILITIES_ROW_ID}'`,
    ),
  ] as const);
  // The seat row's cell: narrow at the boundary (unknown → string|null).
  const seatRow: unknown = imageSourceResult?.results[0];
  let imageSourceProviderId: string | null = null;
  if (typeof seatRow === "object" && seatRow !== null && "provider_id" in seatRow) {
    const seatValue: unknown = seatRow.provider_id;
    if (typeof seatValue === "string") imageSourceProviderId = seatValue;
  }
  // One boundary cast: the rows statement is the SAME typed query the
  // pre-batch `.all<ProviderConfigDbRow>()` trusted — batch erases the
  // per-statement generic, this restores it.
  const result = rowsResult as { results: ProviderConfigDbRow[] };
  // Same boundary cast as `result` — the web_search statement returns 0..1 rows.
  const webSearchRows = webSearchResult as { results: WebSearchDbRow[] };
  const webSearchRow = webSearchRows.results[0];
  // Same boundary cast — the tool_capabilities statement returns 0..1 rows.
  const toolCapabilitiesRows = toolCapabilitiesResult as { results: ToolCapabilitiesDbRow[] };
  const toolCapabilitiesRow = toolCapabilitiesRows.results[0];
  // Absent row = the ruled omp posture (all gates off — the shared defaults,
  // one owner), never an env override; the 0/1 decode is strict (the
  // service_tier precedent).
  const toolCapabilities: ToolCapabilitiesOverlayRow =
    toolCapabilitiesRow === undefined
      ? { ...DEFAULT_EXPERIMENTAL_TOOL_CONFIG, configured: false }
      : {
          configured: true,
          externalThinking: toolCapabilitiesRow.external_thinking === 1,
          contextNotes: toolCapabilitiesRow.context_notes === 1,
          checkpoint: toolCapabilitiesRow.checkpoint === 1,
        };
  // Map the D1 rows onto the seam-neutral shape the shared assembler decodes;
  // the ciphertext re-attaches separately (the decrypt half's rowSecrets).
  const rowSecrets: Record<string, string | null> = {};
  const rawRows: ProviderConfigRawRow[] = result.results.map((row) => {
    rowSecrets[row.id] = row.api_key_enc;
    return {
      id: row.id,
      displayName: row.display_name,
      baseUrl: row.base_url,
      api: row.api,
      serviceTier: row.service_tier === 1,
      hasCredential: row.api_key_enc !== null,
      models: row.models,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  const warnings: string[] = [];
  const webSearchHalf = await legacyWebSearchHalf(
    webSearchRow,
    options,
    env.PROVIDER_CONFIG_MASTER_KEY,
    warnings,
  );
  return await assembleProviderConfigLoad(
    {
      rows: rawRows,
      rowSecrets,
      imageSourceProviderId,
      toolCapabilities,
      webSearch: webSearchHalf,
    },
    { decrypt: options.decrypt, masterKey: env.PROVIDER_CONFIG_MASTER_KEY },
    warnings,
  );
}

/**
 * The legacy D1 row's raw-cell decode into the shared half shape: JSON cells
 * parse with the skip-with-warning discipline, the ciphertext decrypts
 * (decrypt half only), and every failure maps to the loud decodeError half —
 * no default chain is ever silently substituted. The assembly itself
 * (resolution, projection, fingerprint) lives in assembleDecodedWebSearchHalf.
 */
async function legacyWebSearchHalf(
  row: WebSearchDbRow | undefined,
  options: { decrypt: boolean },
  masterKey: string | undefined,
  warnings: string[],
): Promise<WebSearchDecodedHalf | null> {
  if (row === undefined) return null;
  const loud = (reason: string): WebSearchDecodedHalf => {
    warnings.push(`web_search config row: ${reason} — decodeError (row kept, no chain served)`);
    return {
      configured: true,
      decodeError: true,
      chain: [],
      timeoutSeconds: null,
      engines: null,
      secrets: null,
      secretsMeta: null,
      updatedAt: row.updated_at,
    };
  };
  let secrets: WebSearchStoredSecrets | undefined;
  if (options.decrypt && row.secrets_enc !== null) {
    if (masterKey === undefined || masterKey === "") {
      warnings.push(
        "web_search config row: secrets_enc present but PROVIDER_CONFIG_MASTER_KEY is not configured — engines needing secrets will report unconfigured",
      );
    } else {
      try {
        secrets = JSON.parse(
          await decryptProviderSecret(masterKey, row.secrets_enc),
        ) as WebSearchStoredSecrets;
      } catch (error) {
        return loud(
          `secrets_enc is not decryptable (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }
  const storedEngines = parseJsonCell("engines", row.engines, warnings) as
    WebSearchStoredEngines | undefined;
  if (row.engines !== null && storedEngines === undefined) {
    return loud("engines is not valid JSON");
  }
  const chain = parseJsonCell("chain", row.chain, warnings) as string[] | undefined;
  if (chain === undefined) return loud("chain is not valid JSON");
  // A broken presence-map cell skips with a warning (presence booleans read
  // false) — the loud posture is reserved for the chain/engines/secrets
  // halves that carry real content.
  const meta = parseJsonCell("secrets_meta", row.secrets_meta, warnings) as
    WebSearchSecretsMeta | undefined;
  return {
    configured: true,
    decodeError: false,
    chain,
    timeoutSeconds: row.timeout_seconds,
    engines: storedEngines ?? null,
    secrets: secrets ?? null,
    secretsMeta: meta ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * Assemble the #449 web_search halves from the decoded half: the secret-free
 * overlay projection, the dispatch config (decrypt half only), and the
 * fingerprint content. Validation runs through resolveWebSearchConfig — the
 * SAME single path the panel write face uses, so a stored row can never
 * serve a chain the write face would have rejected. A broken half is a loud
 * decodeError (skip-with-warning discipline): the row stays in D1, the
 * projection faces report it, and no defaults are silently substituted.
 */
function assembleDecodedWebSearchHalf(
  half: WebSearchDecodedHalf | null,
  decrypt: boolean,
  warnings: string[],
): WebSearchAssembly {
  if (!half?.configured) {
    return {
      overlay: {
        configured: false,
        decodeError: false,
        projection: projectWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG),
        engines: null,
      },
      config: null,
      fingerprint: null,
    };
  }
  if (half.decodeError) {
    return {
      overlay: { configured: true, decodeError: true, projection: null, engines: null },
      config: null,
      fingerprint: JSON.stringify({ decodeError: true, updatedAt: half.updatedAt }),
    };
  }
  let config: WebSearchConfig;
  try {
    config = resolveWebSearchConfig(DEFAULT_WEB_SEARCH_CONFIG, {
      chain: half.chain,
      ...(half.timeoutSeconds !== null ? { timeoutSeconds: half.timeoutSeconds } : {}),
      engines: {
        ...(half.secrets?.brave?.apiKey !== undefined
          ? { brave: { apiKey: half.secrets.brave.apiKey } }
          : {}),
        ...(half.secrets?.exa?.apiKey !== undefined
          ? { exa: { apiKey: half.secrets.exa.apiKey } }
          : {}),
        searxng: { ...half.engines?.searxng, ...half.secrets?.searxng },
      },
    });
  } catch (error) {
    warnings.push(
      `web_search config row: ${error instanceof Error ? error.message : String(error)} — decodeError (row kept, no chain served)`,
    );
    return {
      overlay: { configured: true, decodeError: true, projection: null, engines: null },
      config: null,
      fingerprint: JSON.stringify({ decodeError: true, updatedAt: half.updatedAt }),
    };
  }
  // Presence map: the decrypt half derives it from the real secrets; the
  // catalog half reads the plaintext meta column. The "(stored)" marker is
  // presence-only — the projection emits booleans, never a value.
  const meta = half.secretsMeta;
  const faceEngines: WebSearchFaceEngines = {
    brave: {
      // The decrypt half reads the real secrets; the catalog half the meta.
      hasApiKey: decrypt ? half.secrets?.brave?.apiKey !== undefined : meta?.brave?.apiKey === true,
    },
    exa: {
      hasApiKey: decrypt ? half.secrets?.exa?.apiKey !== undefined : meta?.exa?.apiKey === true,
    },
    searxng: {
      endpoint: half.engines?.searxng?.endpoint ?? null,
      categories: half.engines?.searxng?.categories ?? null,
      language: half.engines?.searxng?.language ?? null,
      safesearch: half.engines?.searxng?.safesearch ?? null,
      hasToken: decrypt
        ? half.secrets?.searxng?.token !== undefined
        : meta?.searxng?.token === true,
      hasBasicAuth: decrypt
        ? (half.secrets?.searxng?.basicUsername ?? half.secrets?.searxng?.basicPassword) !==
          undefined
        : meta?.searxng?.basic === true,
    },
  };
  const overlay: WebSearchOverlayRow = {
    configured: true,
    decodeError: false,
    projection: decrypt
      ? projectWebSearchConfig(config)
      : projectWebSearchConfig({
          ...config,
          engines: {
            brave: meta?.brave?.apiKey === true ? { apiKey: "(stored)" } : config.engines.brave,
            exa: meta?.exa?.apiKey === true ? { apiKey: "(stored)" } : config.engines.exa,
            searxng: config.engines.searxng,
          },
        }),
    engines: faceEngines,
  };
  return {
    overlay,
    config: decrypt ? config : null,
    fingerprint: JSON.stringify({
      chain: config.chain,
      timeoutSeconds: config.timeoutSeconds,
      engines: half.engines ?? {},
      secretsMeta: meta ?? {},
      updatedAt: half.updatedAt,
    }),
  };
}

/**
 * Content-only fingerprint: provider declarations in full, credential
 * PRESENCE per id, the newest updated_at (so a key-only rotation still
 * bumps it), and the #448 image-source selection (a seat-only flip
 * hot-applies), and the #449 web_search engine-chain content (chain order,
 * non-secret engine settings, secret PRESENCE meta, updated_at — a key-only
 * rotation still bumps it), and the #502 tool-capability content (a gate
 * flip hot-applies). Values of secrets never enter the string.
 */
async function fingerprintOf(
  providers: Record<string, RelayCatalogProvider>,
  credentials: RelayProviderCredentialMap,
  maxUpdatedAt: number,
  imageSourceProviderId: string | null,
  webSearchContent: string | null,
  toolCapabilitiesContent: string,
): Promise<string> {
  const content = JSON.stringify({
    providers,
    credentialPresence: Object.fromEntries(
      Object.entries(credentials).map(([id, slot]) => [id, slot.apiKey !== undefined]),
    ),
    maxUpdatedAt,
    imageSourceProviderId,
    webSearch: webSearchContent,
    toolCapabilities: toolCapabilitiesContent,
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
): Promise<ProviderConfigFullOverlay | null> {
  const load = await readProviderConfigs(env, { decrypt: true });
  if (load === null) return null;
  for (const warning of load.warnings) console.warn(`[provider-configs] ${warning}`);
  return {
    ...load.catalog,
    rows: load.rows,
    credentials: load.credentials,
    webSearchConfig: load.webSearchConfig,
  };
}
