/**
 * #504: the bb config.dataDir analogue as a named constant. The Worker has
 * no filesystem — the value is a pure display/decoration label, never a real
 * path:
 *
 * - the `cwd` stamped onto thread/start commands (seam/agent-do.ts — bb
 *   carries config.dataDir there);
 * - the `dataDir` field of GET /system/config (routes/system.ts — bb shape
 *   kept for the SPA).
 *
 * The former DATA_DIR env var was a pseudo-configuration spelling of this
 * constant (#497 census: the Worker has no fs, so there is nothing to
 * configure) and is retired.
 */
export const BB_DATA_DIR_LABEL = "/data";
