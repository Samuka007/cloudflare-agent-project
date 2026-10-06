#!/usr/bin/env node
// Stage the cap-provider-config frontend plugin (#382): copy the built dist
// beside the SPA assets and write the descriptor the worker's static plugin
// registry reads (apps/server-worker/src/services/plugin-registry.ts).
//
// Invoked by scripts/stage-bb-spa.sh after the SPA staging (the single
// staging source shared by ci.yml, deploy-staging.yml and `nix run
// .#staging-deploy`), so the served plugin set cannot drift from the one CI
// tested.
//
// The registry hash is the bb loadPluginAppBundle digest — first 16 hex of
// sha256 over app.js ‖ app.css (when present) ‖ app.meta.json
// (bb apps/server/src/services/plugins/app-bundle.ts:345-348) — so the
// served bundle and the GET /plugins entry can never disagree.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(
  repoRoot,
  "bb/plugins/cap-provider-config/dist",
);
const stageDir = resolve(
  repoRoot,
  "apps/server-worker/public/plugins/cap-provider-config",
);

const readAsset = (name) => readFile(resolve(distDir, name));

const meta = JSON.parse(await readAsset("app.meta.json"));
if (typeof meta.pluginVersion !== "string" || typeof meta.sdkMajor !== "number" || typeof meta.sdkVersion !== "string") {
  throw new Error("app.meta.json is missing pluginVersion/sdkMajor/sdkVersion");
}
const js = await readAsset("app.js");
const css = await readAsset("app.css").catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});

const hasher = createHash("sha256").update(js);
if (css !== null) hasher.update(css);
hasher.update(await readAsset("app.meta.json"));
const hash = hasher.digest("hex").slice(0, 16);

const descriptor = {
  id: "cap-provider-config",
  name: "Providers",
  description:
    "User-configurable LLM providers: CRUD onto the server's provider_configs (hot-applied) plus the read-only deployment projection.",
  icon: "Puzzle",
  version: meta.pluginVersion,
  sdkMajor: meta.sdkMajor,
  sdkVersion: meta.sdkVersion,
  hash,
  files: { js: true, css: css !== null },
};

await rm(stageDir, { recursive: true, force: true });
await mkdir(resolve(stageDir, "assets"), { recursive: true });
await copyFile(resolve(distDir, "app.js"), resolve(stageDir, "assets/app.js"));
await copyFile(
  resolve(distDir, "app.meta.json"),
  resolve(stageDir, "assets/app.meta.json"),
);
if (css !== null) {
  await copyFile(resolve(distDir, "app.css"), resolve(stageDir, "assets/app.css"));
}
await writeFile(
  resolve(stageDir, "registry.json"),
  `${JSON.stringify(descriptor, null, 2)}\n`,
);
console.log(`== plugin staged: cap-provider-config hash ${hash}, sdk ${descriptor.sdkVersion} ==`);
