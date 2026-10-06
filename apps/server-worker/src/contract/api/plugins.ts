//
// Ported subset of bb packages/server-contract/src/api/plugins.ts
// (Samuka007/bb fork of get-bb/bb, installedPluginSchema family, commit
// 8473d8c33-era shape) — only the fields the CAP static registry serves,
// plus the plugin app-bundle slice (PluginAppState) verbatim.
//
import { z } from "zod";

/**
 * bb GET /api/v1/plugins entries are validated client-side by the bb SDK
 * browser client (`requestParsed` zod-parses with the full
 * installedPluginSchema — packages/sdk/src/areas/plugins.ts:438-441), so the
 * static registry entry must satisfy every required field of that schema or
 * the SPA's settings-nav plugin list query throws. This contract ports the
 * schema (same field set) and the response wrapper.
 */

export const pluginRuntimeStatusSchema = z.enum([
  "running",
  "error",
  "incompatible",
  "missing",
  "disabled",
  "degraded",
  "needs-configuration",
]);
export type PluginRuntimeStatus = z.infer<typeof pluginRuntimeStatusSchema>;

export const pluginUpdateOutcomeSchema = z.enum([
  "current",
  "update-available",
  "pinned",
  "incompatible",
  "unavailable",
]);
export type PluginUpdateOutcome = z.infer<typeof pluginUpdateOutcomeSchema>;

export const pluginUpdateStateSchema = z.object({
  outcome: pluginUpdateOutcomeSchema.optional(),
  detail: z.string().optional(),
  availableVersion: z.string().optional(),
  blockedVersion: z.string().optional(),
  blockedReasons: z.array(z.string()).optional(),
  lastCheckAt: z.number().optional(),
  lastFailure: z
    .object({ version: z.string(), at: z.number(), detail: z.string() })
    .optional(),
});
export type PluginUpdateState = z.infer<typeof pluginUpdateStateSchema>;

export const pluginHandlerStatsSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
  errorCount: z.number(),
});
export type PluginHandlerStats = z.infer<typeof pluginHandlerStatsSchema>;

export const pluginServiceEntrySchema = z.object({
  name: z.string(),
  state: z.enum(["running", "backoff", "stopped"]),
});
export type PluginServiceEntry = z.infer<typeof pluginServiceEntrySchema>;

export const pluginScheduleEntrySchema = z.object({
  name: z.string(),
  cron: z.string(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.enum(["running", "ok", "error"]).nullable(),
  lastError: z.string().nullable(),
});
export type PluginScheduleEntry = z.infer<typeof pluginScheduleEntrySchema>;

/** bb pluginAppStateSchema (server-contract/src/api/plugins.ts:142-154). */
export const pluginAppStateSchema = z.object({
  hasApp: z.boolean(),
  bundle: z
    .object({
      jsUrl: z.string(),
      cssUrl: z.string().nullable(),
      hash: z.string(),
      sdkMajor: z.number(),
      sdkVersion: z.string(),
      compatible: z.boolean(),
    })
    .nullable(),
});
export type PluginAppState = z.infer<typeof pluginAppStateSchema>;

export const installedPluginSchema = z.object({
  id: z.string(),
  source: z.string(),
  rootDir: z.string(),
  version: z.string(),
  provenance: z.enum(["builtin", "direct", "catalog"]),
  isOrphanedBuiltin: z.boolean(),
  catalogEntryId: z.string().optional(),
  catalogMarketplaceName: z.string().optional(),
  publisherLabel: z.string().nullable(),
  sourceDisplay: z.string(),
  updateState: pluginUpdateStateSchema,
  enabled: z.boolean(),
  description: z.string().nullable(),
  name: z.string().nullable(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable(),
  status: pluginRuntimeStatusSchema,
  statusDetail: z.string().nullable(),
  handlerStats: pluginHandlerStatsSchema,
  services: z.array(pluginServiceEntrySchema),
  schedules: z.array(pluginScheduleEntrySchema),
  cliCommand: z.object({ name: z.string(), summary: z.string() }).nullable(),
  capabilities: z.array(z.never()).default([]),
  hasSettings: z.boolean(),
  app: pluginAppStateSchema,
  logoUrl: z.string().nullable(),
  logoDarkUrl: z.string().nullable(),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const pluginListResponseSchema = z.object({
  plugins: z.array(installedPluginSchema),
});
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

/**
 * bb GET /plugins/contributions → `{ cliCommands, mentionProviders }`
 * (server-contract api/plugins.ts:198-206): fast metadata, no plugin code
 * run. The static registry contributes neither.
 */
export const pluginContributionsResponseSchema = z.object({
  cliCommands: z.array(z.never()),
  mentionProviders: z.array(z.never()),
});
export type PluginContributionsResponse = z.infer<
  typeof pluginContributionsResponseSchema
>;

/**
 * The staged per-plugin descriptor (written by scripts/stage-bb-spa.sh next
 * to the built bundle at public/plugins/<id>/registry.json). The stage
 * script computes `hash` = first 16 hex of sha256 over app.js bytes ‖
 * app.css bytes (when present) ‖ app.meta.json bytes — the bb
 * loadPluginAppBundle digest (apps/server/src/services/plugins/
 * app-bundle.ts:345-348) — and copies sdkMajor/sdkVersion from the built
 * meta, so the worker never bakes bundle hashes into source.
 */
export const pluginRegistryDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  icon: z.string(),
  version: z.string(),
  sdkMajor: z.number(),
  sdkVersion: z.string(),
  hash: z.string().regex(/^[0-9a-f]{16}$/),
  files: z.object({ js: z.boolean(), css: z.boolean() }),
});
export type PluginRegistryDescriptor = z.infer<
  typeof pluginRegistryDescriptorSchema
>;
