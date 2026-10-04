//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

/**
 * bb serves the plugins face from apps/server/src/routes/plugins.ts:196-206
 * without a product zod contract — "This surface is server-policy glue, not
 * part of the typed product contract" (plugins.ts:185). The port pins the
 * experiment-off empty state (plugins.ts:198-200: "empty (not an error) while
 * the experiment is off") because the port has no plugin system: a non-empty
 * list here is a contract violation until the element schemas are ported.
 */

/** bb GET /plugins → `{ plugins: plugins.list() }` (plugins.ts:196). */
export const pluginListResponseSchema = z.object({
  plugins: z.array(z.never()),
});
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

/**
 * bb GET /plugins/contributions →
 * `{ cliCommands, mentionProviders }` (plugins.ts:201-206); fast metadata for
 * the CLI help/proxy path and host-rendered UI contributions, with no plugin
 * code run.
 */
export const pluginContributionsResponseSchema = z.object({
  cliCommands: z.array(z.never()),
  mentionProviders: z.array(z.never()),
});
export type PluginContributionsResponse = z.infer<typeof pluginContributionsResponseSchema>;
