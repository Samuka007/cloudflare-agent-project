/**
 * #506 the browser-origin allowlist domain: the strict origin grammar shared
 * by the Origin guard (request targets + incoming Origin header), the D1
 * seat decoder, and the /system/origin-allowlist write face. parseOriginLike
 * is moved verbatim from middleware/origin-guard.ts so every consumer parses
 * with ONE grammar (a guard accept must equal a face accept). The PUT-face
 * zod schema lives in contract/api/system.ts with its sibling face schemas —
 * this module is the grammar, not the wire contract.
 */

/**
 * A value parses as an origin-like URL only when it is http/https with no
 * credentials, path (beyond "/"), query, or hash. Returns the parsed URL so
 * callers can take `.origin` (canonical form) or `.hostname`.
 */
export function parseOriginLike(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Canonical form (parseOriginLike's `.origin`) of a validated entries list,
 * order-preserving and deduplicated — what the seat stores and what the
 * guard compares against.
 */
export function canonicalOriginAllowlist(entries: string[]): string[] {
  const origins: string[] = [];
  for (const entry of entries) {
    const parsed = parseOriginLike(entry);
    if (parsed !== null && !origins.includes(parsed.origin)) {
      origins.push(parsed.origin);
    }
  }
  return origins;
}
