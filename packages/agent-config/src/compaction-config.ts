import { z } from "zod";

/**
 * Compact-mode taxonomy (#547) and the methodOrder preference resolution.
 * Config-only: the pi-durable runtime owns the actual compaction engine.
 */

export const compactModeSchema = z.enum(["soft", "remote", "snap"]);
export type CompactMode = z.infer<typeof compactModeSchema>;

/**
 * omp DEFAULT_COMPACTION_METHOD_ORDER reduced to the three modes this port
 * ships. This is the omp canonical order an operator writes into the
 * deployment's compaction seat — NOT the absent-row runtime default.
 */
export const DEFAULT_COMPACTION_METHOD_ORDER: readonly CompactMode[] = ["remote", "snap", "soft"];

/** Runtime guard for a configured mode token (omp isCompactionMethod). */
export function isCompactMode(value: unknown): value is CompactMode {
  return value === "soft" || value === "remote" || value === "snap";
}

/**
 * omp resolveCompactionMethodOrder: filter malformed entries and dedupe,
 * preserving first-occurrence order. Empty input = an empty order.
 */
export function resolveCompactionMethodOrder(value: unknown): CompactMode[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<CompactMode>();
  for (const entry of value) {
    if (isCompactMode(entry)) seen.add(entry);
  }
  return [...seen];
}

/**
 * The eligibility predicate one mode answers for a deployment: `remote`
 * needs a configured remote summarizer, `snap`/`soft` are always eligible.
 */
export type CompactModeEligibility = (mode: CompactMode) => boolean;

/**
 * Resolve the effective mode: an explicit request mode wins, otherwise the
 * first eligible entry of the preference order; `soft` is the floor.
 */
export function resolveCompactMode(
  order: readonly CompactMode[],
  explicit: CompactMode | undefined,
  eligible: CompactModeEligibility,
): CompactMode {
  if (explicit !== undefined) return explicit;
  for (const mode of order) {
    if (eligible(mode)) return mode;
  }
  return "soft";
}
