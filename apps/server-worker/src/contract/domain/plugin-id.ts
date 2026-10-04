//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
/**
 * Derive the stable plugin id used for routes, storage, settings, and CLI
 * commands from an npm package name.
 *
 * `bb-plugin-linear` becomes `linear`; scoped names first drop the scope.
 */
export function derivePluginId(packageName: string): string {
  const base = packageName.includes("/")
    ? (packageName.split("/").at(-1) ?? packageName)
    : packageName;
  const id = base
    .replace(/^bb-plugin-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (id.length === 0) {
    throw new Error(`cannot derive a plugin id from package name "${packageName}"`);
  }
  return id;
}
