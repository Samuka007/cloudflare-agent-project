// Absolute specifiers: the probe lives outside any node_modules tree that
// links the omp workspace packages.
import * as natives from "/home/nixos/workspace/oh-my-pi/packages/natives/native/index.js";
import { nativeAddonStatus } from "/home/nixos/workspace/oh-my-pi/packages/natives/native/loader-state.js";

const probe = {
  glob: typeof natives.glob,
  grep: typeof natives.grep,
  editStore: typeof natives.EditStore,
  editSession: typeof natives.EditSession,
  desktopSession: typeof natives.DesktopSession,
  astGrep: typeof natives.astGrep,
  astEdit: typeof natives.astEdit,
  buildVersion: natives.__piNativesBuildVersion,
  status: nativeAddonStatus(),
};
console.log(JSON.stringify(probe, null, 2));
const hits = natives.grep({ paths: ["/tmp/omp-spike/fixture"], pattern: "GrepNeedle", limit: 5 });
console.log("grep smoke:", String(hits).slice(0, 200));
