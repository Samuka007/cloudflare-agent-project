/**
 * bb flattenPromptInputGroups (provider-adapter.ts:237-249) — ported verbatim.
 *
 * Provenance note: @cap/daemon-worker implements this helper but its package
 * exports map only exposes the main entry (which does not re-export it), so
 * the provider application carries the verbatim port until the seam types get
 * a dedicated export path (see ticket #28 report — PM reconciliation).
 */

import type { PromptInput } from "../../daemon-worker/src/provider-types.js";

export function flattenPromptInputGroups(
  input: PromptInput[],
  inputGroups: PromptInput[][] | undefined,
): PromptInput[] {
  if (inputGroups === undefined) {
    return input;
  }
  return inputGroups.flatMap((group, index) =>
    index === 0
      ? group
      : [
          { type: "text" as const, text: "\n\n", mentions: [] },
          ...group,
        ],
  );
}
