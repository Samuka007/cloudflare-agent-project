import type { PromptInput } from "../contract/domain/shared-types.js";

/**
 * bb apps/server/src/services/threads/title-generation.ts:53-68, ported
 * verbatim: the sidebar title fallback is the cleaned first-prompt text,
 * truncated at 80 chars (77 + "...") rather than left for the SPA to guess
 * from the bare thread id.
 */
function cleanPromptText(input: PromptInput[]): string {
  return input
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deriveTitleFallback(input: PromptInput[]): string | null {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return null;
  }
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}
