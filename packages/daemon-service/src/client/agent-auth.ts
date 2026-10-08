import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// Subpath import, not the barrel: the daemon client runs in Node — the
// barrel would transitively load agent-do.ts (cloudflare:workers). The
// dictionary module is zod-only by design.
import { relayModelEntrySchema } from "@cap/agent-do/provider-catalog";
import { z } from "zod";

/**
 * Daemon provider channel (M1.5 #145) — the auth/ModelRegistry seam
 * behind find's judge. Mirrors the #102 web_search provider-config pattern:
 * a daemon-side env JSON (`DAEMON_AGENT_AUTH`) decoded once over neutral
 * defaults, deployment-time input, never model-reachable.
 *
 * Shape (all optional, composable):
 * - `providers` — custom OpenAI-compatible provider defs written verbatim
 *   into `<agentDir>/models.yml` (the canonical omp custom-provider config:
 *   baseUrl + apiKey + models with explicit cost rates). The ModelRegistry
 *   loads that file at construction; a deployment may also drop models.yml
 *   into the daemon-private agentDir by hand and skip the env entirely.
 * - `runtimeKeys` — provider → API key installed via
 *   `authStorage.keys.setRuntime` (top cascade precedence, omp
 *   auth/cascade.ts:206) — the credential-only channel for bundled
 *   catalog providers.
 * - `judgeRole` — pins `modelRoles.judge` in the host settings overrides
 *   (omp settings `modelRoles.judge`), pointing the judge role chain at a
 *   concrete `provider/model`.
 */

/**
 * The shared model-entry field dictionary (#350): the SAME zod vocabulary
 * the edge MODEL_RELAY_CATALOG declaration uses
 * (packages/agent-do/src/provider-catalog.ts) — one dictionary across the
 * two trust domains so the field sets cannot drift apart (roadmap §4.4).
 */
const providerModelSchema = relayModelEntrySchema;

const providerSchema = z.object({
  baseUrl: z.string().min(1),
  api: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  auth: z.enum(["apiKey", "none"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(providerModelSchema).min(1),
});

export type AgentAuthModelConfig = z.infer<typeof providerModelSchema>;

export interface AgentAuthProviderConfig {
  baseUrl: string;
  api?: string;
  apiKey?: string;
  auth?: "apiKey" | "none";
  headers?: Record<string, string>;
  models: AgentAuthModelConfig[];
}

export interface AgentAuthConfig {
  /** Custom provider defs materialized as `<agentDir>/models.yml`. */
  providers: Record<string, AgentAuthProviderConfig>;
  /** Provider → API key at runtime-key precedence (bundled providers). */
  runtimeKeys: Record<string, string>;
  /** Pins `modelRoles.judge` (e.g. "myrelay/judge-mock"). */
  judgeRole: string | undefined;
}

/** Neutral defaults — an unset env means "whatever the agentDir carries". */
export const DEFAULT_AGENT_AUTH_CONFIG: AgentAuthConfig = {
  providers: {},
  runtimeKeys: {},
  judgeRole: undefined,
};

const agentAuthPatchSchema = z.object({
  providers: z.record(z.string().min(1), providerSchema).optional(),
  runtimeKeys: z.record(z.string().min(1), z.string().min(1)).optional(),
  judgeRole: z.string().min(1).optional(),
});

/**
 * Decode the `DAEMON_AGENT_AUTH` env JSON (#102 resolveWebSearchConfig
 * shape). Shape violations throw (zod) — rejection, not silent fallback.
 */
export function decodeAgentAuthConfig(
  raw: string | undefined,
  base: AgentAuthConfig = DEFAULT_AGENT_AUTH_CONFIG,
): AgentAuthConfig {
  if (raw === undefined || raw.trim() === "") return base;
  const patch = agentAuthPatchSchema.parse(JSON.parse(raw));
  return {
    providers: patch.providers ?? base.providers,
    runtimeKeys: patch.runtimeKeys ?? base.runtimeKeys,
    judgeRole: patch.judgeRole ?? base.judgeRole,
  };
}

/**
 * Materialize the configured custom providers as `<agentDir>/models.yml`.
 * Written BEFORE the ModelRegistry constructor loads the file; an empty
 * provider table writes nothing (hand-placed models.yml stays authoritative).
 */
export async function installAgentAuth(
  agentDir: string,
  config: AgentAuthConfig | null,
): Promise<void> {
  if (config === null || Object.keys(config.providers).length === 0) return;
  const modelsYml = { providers: config.providers };
  const rendered = renderYaml(modelsYml, 0);
  await writeFile(join(agentDir, "models.yml"), rendered, "utf8");
}

/**
 * Minimal stable YAML emitter for the provider-config shape (objects,
 * arrays, strings, numbers, booleans). Strings are always single-quoted —
 * URLs and ids carry `:`/`/`, and always-quote keeps the renderer total
 * without a scalar-type guessing pass. Key order is insertion order, so a
 * byte-identical re-render follows a byte-identical config.
 */
function renderYaml(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value.map((item) => `${pad}-\n${renderYaml(item, indent + 1)}`).join("");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries
      .map(([key, member]) => {
        if (member !== null && typeof member === "object" && !Array.isArray(member)) {
          const nested = renderYaml(member, indent + 1);
          return `${pad}${key}:\n${nested}`;
        }
        return `${pad}${key}:${renderScalar(member, indent + 1)}`;
      })
      .join("");
  }
  return `${pad}${renderScalar(value, indent)}\n`;
}

function renderScalar(value: unknown, indent: number): string {
  if (value === null || value === undefined) return " null\n";
  if (typeof value === "string") return ` '${value.replaceAll("'", "''")}'\n`;
  if (typeof value === "number" || typeof value === "boolean") return ` ${String(value)}\n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return ` []\n`;
    return `\n${renderYaml(value, indent)}`;
  }
  return `\n${renderYaml(value, indent)}`;
}
