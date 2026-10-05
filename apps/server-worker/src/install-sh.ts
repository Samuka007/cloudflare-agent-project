/**
 * GET /install.sh (#258) — the bootstrap the pinned SPA's Add-a-machine
 * dialog prints (`curl <server>/install.sh | sh -s -- --join-code … --host-id
 * … --server …`, AddMachineDialog.tsx pairingCommand). bb's S9 ships a full
 * npm-package installer; this deployment's daemon is a Nix closure
 * (flake.nix `packages.daemon` → app alias `cap-daemon`), so the honest
 * equivalent is: verify the target has nix, then `nix run` the daemon with
 * the join code. The flag contract (`--join-code`, `--host-id`, `--server`)
 * is the dialog's, honored verbatim; failure is loud with a next action, the
 * join code itself is the capability so the route needs no auth (bb ships
 * /install.sh public for the same reason, docs/multiple-devices.md).
 */

const FLAKE_REF_FALLBACK = "github:Samuka007/cloudflare-agent-project#cap-daemon";

export function installShScript(): string {
  return `#!/bin/sh
# cap host onboarding bootstrap (#258) — enroll this machine as an execution
# host against the cap server. Flags follow the Add-a-machine dialog contract.
set -eu

JOIN_CODE=""
HOST_ID=""
SERVER=""
MACHINE_CODE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --join-code) JOIN_CODE="\${2:?--join-code needs a value}"; shift 2 ;;
    --host-id)   HOST_ID="\${2:?--host-id needs a value}"; shift 2 ;;
    --server)    SERVER="\${2:?--server needs a value}"; shift 2 ;;
    --machine-code)
      MACHINE_CODE="\${2:?--machine-code needs a value}"; shift 2 ;;
    *)
      echo "cap-onboard: unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

[ -n "$JOIN_CODE" ] || { echo "cap-onboard: --join-code is required (mint one in the Add machine dialog)" >&2; exit 2; }
[ -n "$SERVER" ]    || { echo "cap-onboard: --server is required (the server URL the dialog shows)" >&2; exit 2; }
[ -n "$HOST_ID" ] && echo "cap-onboard: note: --host-id is advisory here; the server assigns the identity carried by the join code" >&2
[ -n "$MACHINE_CODE" ] && echo "cap-onboard: note: --machine-code ignored (the connect tunnel is not part of this deployment)" >&2

if ! command -v nix >/dev/null 2>&1; then
  echo "cap-onboard: 'nix' is required on this machine to fetch the cap-daemon closure." >&2
  echo "  install Nix:  sh <(curl -L https://nixos.org/nix/install) --daemon" >&2
  echo "  then re-run this command. Full steps: the server's docs/ops/host-onboarding.md" >&2
  exit 1
fi

FLAKE_REF="\${CAP_FLAKE_REF:-${FLAKE_REF_FALLBACK}}"
echo "cap-onboard: fetching cap-daemon via \\"nix run $FLAKE_REF\\" (first run builds a ~600 MiB closure)"
echo "cap-onboard: enrolling against $SERVER — the daemon runs in the foreground; Ctrl-C stops it"
echo "cap-onboard: keep it running with systemd afterwards — see docs/ops/host-onboarding.md"

exec nix run "$FLAKE_REF" -- --server "$SERVER" --join-code "$JOIN_CODE"
`;
}
