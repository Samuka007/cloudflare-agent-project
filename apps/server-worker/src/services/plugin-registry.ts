import {
  installedPluginSchema,
  pluginRegistryDescriptorSchema,
  type PluginRegistryDescriptor,
} from "../contract/api/plugins.js";
import type { Env } from "../env.js";

/**
 * The static plugin registry (#382): the CAP port of bb's plugin serving
 * face, scoped to what one first-party plugin needs — a manifest/asset
 * descriptor served from the composed deployment's static assets, no plugin
 * runtime (no BUILTIN_PLUGINS registry, no install/enable lifecycle, no
 * server-side plugin code). bb anchor: apps/server/src/routes/plugins.ts:196
 * (`{ plugins: plugins.list() }`) + app-bundle.ts:312-365 (bundle
 * inventory), reduced to a data-driven single entry.
 *
 * The descriptor is written at deploy time by scripts/stage-bb-spa.sh (the
 * single staging source, CI/CD/local share it) next to the built bundle; the
 * worker reads it through the ASSETS binding per request, so bundle content
 * changes need no source edit. A missing descriptor — dev checkouts without
 * a staged plugin — is the bb "experiment off" state: empty (not an error),
 * which is exactly the pre-#382 placeholder response.
 */

/** bb PLUGIN_SDK_MAJOR (packages/domain/src/plugin-sdk-version.ts:19-22):
 * the frontend skips bundles whose sdkMajor differs from the running SDK's
 * major; the port pins the same major the SPA build carries. */
const PLUGIN_SDK_MAJOR = 0;

const REGISTRY_ID = "cap-provider-config";

/** Served asset response + the current hash, for the route's cache policy. */
export interface PluginRegistryAsset {
  /** The ASSETS-served bytes; the route streams `response.body` through. */
  assetResponse: Response;
  hash: string;
  contentType: string;
}

async function readDescriptor(
  env: Env,
): Promise<PluginRegistryDescriptor | null> {
  const url = new URL(
    `/plugins/${REGISTRY_ID}/registry.json`,
    "https://cap-server-worker.invalid",
  );
  const response = await env.ASSETS.fetch(new Request(url));
  if (!response.ok) return null;
  const parsed = pluginRegistryDescriptorSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

function assetUrl(id: string, file: string, hash: string): string {
  // bb app-bundle.ts:349-350: app-relative asset URL, content-hash included.
  return `/api/v1/plugins/${encodeURIComponent(id)}/assets/${file}?h=${hash}`;
}

/** The GET /plugins entry for the static registry, or null when untracked. */
export async function loadStaticRegistryEntry(env: Env) {
  const descriptor = await readDescriptor(env);
  if (descriptor === null) return null;
  return installedPluginSchema.parse({
    id: descriptor.id,
    // provenance "direct": a fork-shipped first-party plugin, not a catalog
    // install and not one of bb's builtins (the static registry does not port
    // the builtin machinery).
    source: `cap-static-registry:${descriptor.id}`,
    rootDir: `cap-static-registry://${descriptor.id}`,
    version: descriptor.version,
    provenance: "direct",
    isOrphanedBuiltin: false,
    publisherLabel: null,
    sourceDisplay: "CAP static registry",
    updateState: {},
    enabled: true,
    description: descriptor.description,
    name: descriptor.name,
    icon: descriptor.icon,
    iconUrl: null,
    // The SPA candidate filter drops non-"running" entries
    // (plugin-frontend.ts:312) and the settings nav requires enabled rows.
    status: "running",
    statusDetail: null,
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    hasSettings: false,
    app: {
      hasApp: descriptor.files.js,
      bundle: descriptor.files.js
        ? {
            jsUrl: assetUrl(descriptor.id, "app.js", descriptor.hash),
            cssUrl: descriptor.files.css
              ? assetUrl(descriptor.id, "app.css", descriptor.hash)
              : null,
            hash: descriptor.hash,
            sdkMajor: descriptor.sdkMajor,
            sdkVersion: descriptor.sdkVersion,
            compatible: descriptor.sdkMajor === PLUGIN_SDK_MAJOR,
          }
        : null,
    },
    logoUrl: null,
    logoDarkUrl: null,
  });
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
};

/**
 * GET /plugins/:id/assets/:file backing: read the built bundle from the
 * static assets. The route applies bb's cache policy against the returned
 * hash — a URL whose ?h matches is immutable; a stale/absent h is no-store
 * so a stale URL can never pin a stale bundle (bb routes/plugins.ts:297-347).
 */
export async function loadStaticRegistryAsset(
  env: Env,
  id: string,
  file: string,
): Promise<PluginRegistryAsset | null> {
  if (id !== REGISTRY_ID) return null;
  const contentType = ASSET_CONTENT_TYPES[file];
  if (contentType === undefined) return null;
  const descriptor = await readDescriptor(env);
  if (
    descriptor === null ||
    !(file === "app.js" ? descriptor.files.js : descriptor.files.css)
  ) {
    return null;
  }
  const url = new URL(
    `/plugins/${REGISTRY_ID}/assets/${file}`,
    "https://cap-server-worker.invalid",
  );
  const assetResponse = await env.ASSETS.fetch(new Request(url));
  if (!assetResponse.ok || assetResponse.body === null) return null;
  return { assetResponse, hash: descriptor.hash, contentType };
}
