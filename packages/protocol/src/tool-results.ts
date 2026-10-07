import { z } from "zod";

/**
 * #454 tool-result semantics — the "execution did not happen" contract
 * (execution suspension #73: a Host Execution refused before any process
 * runs completes the turn honestly with a placeholder RESULT).
 *
 * The refusal must reach every consumer as a STRUCTURED error, never as
 * exit-0 stdout: the journal row carries `status:"error"` + `errorCode` +
 * a human message, the ux item folds `failed` + the same message, and the
 * model face prefixes a marker so flag-less wire faces (chat-completions
 * role:"tool", responses function_call_output) can never render the failure
 * as if it were command output — the #454 bug: the placeholder rode as
 * `stdout=host_offline` and the model read it as the sandbox hostname.
 *
 * This module is the contract owner (协议正本); agent-do (the generation
 * points: pre-dispatch rejections + the dispatch host_offline placeholder)
 * and daemon-service (the toolResultPayload wire twin) mirror it.
 */

/** Structured codes for tool results whose tool never executed. */
export const toolResultErrorCodeSchema = z.enum([
  /** The target machine (bound or ssh:// overridden) has no live daemon session. */
  "host_offline",
  /** An ssh:// override names a host with no registered row. */
  "unknown_host",
  /** The override target's permission ceiling is below the exec tier (#289 B4). */
  "exec_tier_required",
  /** The hosts registry read failed — a permission gate refuses closed. */
  "registry_unavailable",
]);
export type ToolResultErrorCode = z.infer<typeof toolResultErrorCodeSchema>;

/** Human phrase per code — the body after "tool not executed:". */
export const TOOL_RESULT_ERROR_PHRASE: Record<ToolResultErrorCode, string> = {
  host_offline: "bound host offline",
  unknown_host: "unknown host",
  exec_tier_required: "exec-tier permission required",
  registry_unavailable: "hosts registry unavailable",
};

/**
 * The journal/ux `output` for a not-executed result: the human message
 * ("tool not executed: bound host offline"), optional detail after an em
 * dash. Deterministic and code-addressable — a bare `host_offline` token
 * never rides as command output again.
 */
export function toolNotExecutedMessage(code: ToolResultErrorCode, detail?: string): string {
  const phrase = TOOL_RESULT_ERROR_PHRASE[code];
  return detail === undefined
    ? `tool not executed: ${phrase}`
    : `tool not executed: ${phrase} — ${detail}`;
}

/**
 * Model-face marker prefixed to EVERY non-ok tool result on the wire (all
 * three faces; the anthropic face keeps its `is_error` flag alongside):
 * `[tool error]` / `[tool error host_offline]`. Faces without an error seat
 * carry failure semantics through this marker, never bare stdout (#454).
 */
export function toolResultErrorMarker(errorCode?: ToolResultErrorCode): string {
  return errorCode === undefined ? "[tool error]" : `[tool error ${errorCode}]`;
}
