{
  description = "Dev shell and canonical deploy app for cloudflare-agent-project (M0 walking skeleton).";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
  outputs = { self, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          pnpm_10
        ];
      };

      # Canonical staging deploy (engineering.md 横切实践 12).
      # Usage: nix run .#staging-deploy [-- --skip-spa-build]
      apps.${system}.staging-deploy = {
        type = "app";
        program = "${pkgs.writeShellApplication {
          name = "deploy-staging";
          runtimeInputs = with pkgs; [ git gnugrep coreutils nodejs_22 pnpm_10 ];
          text = ''
            set -euo pipefail
            REPO_ROOT="$(git rev-parse --show-toplevel)"
            cd "$REPO_ROOT"

            if [[ ! -f .dev.vars ]]; then
              echo "ERROR: .dev.vars missing (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)" >&2
              exit 1
            fi
            set -a
            # shellcheck disable=SC1091
            # .dev.vars is an intentional runtime credential file, not a static source target
            source .dev.vars
            set +a
            : "''${CLOUDFLARE_API_TOKEN:?not set in .dev.vars}"
            : "''${CLOUDFLARE_ACCOUNT_ID:?not set in .dev.vars}"

            if [[ ! -d node_modules ]]; then
              echo "ERROR: node_modules missing — run 'pnpm install --frozen-lockfile' first" >&2
              exit 1
            fi

            SKIP_SPA=0
            if [[ "''${1:-}" == "--skip-spa-build" ]]; then SKIP_SPA=1; fi

            if [[ $SKIP_SPA -eq 0 ]]; then
              echo "== building bb SPA (submodule pinned $(git -C bb rev-parse --short HEAD)) =="
              ( cd bb/apps/app && pnpm build )
              rm -rf apps/server-worker/public
              mkdir -p apps/server-worker/public
              cp -r bb/apps/app/dist/* apps/server-worker/public/
            fi

            ENTRY_JS="$(grep -o '/assets/index-[^"]*\.js' apps/server-worker/public/index.html | head -1)"
            if [[ -z "$ENTRY_JS" || ! -f "apps/server-worker/public$ENTRY_JS" ]]; then
              echo "ERROR: SPA entry asset missing (index.html -> ''${ENTRY_JS:-none}); refusing to deploy" >&2
              exit 1
            fi
            ASSET_COUNT="$(find apps/server-worker/public/assets -maxdepth 1 -type f | wc -l)"
            if (( ASSET_COUNT < 10 )); then
              echo "ERROR: only $ASSET_COUNT assets staged; expected a full build (incident #39)" >&2
              exit 1
            fi
            echo "== SPA staged: $ASSET_COUNT assets, entry $ENTRY_JS =="

            SHA="$(git rev-parse --short HEAD)"
            echo "== stamping SERVER_VERSION=$SHA =="
            printf '%s' "$SHA" | ( cd apps/server-worker && pnpm exec wrangler versions secret put SERVER_VERSION -c wrangler.staging.jsonc )

            ( cd apps/server-worker && pnpm exec wrangler deploy -c wrangler.staging.jsonc )
            echo "== deployed $SHA =="
          '';
        }}/bin/deploy-staging";
      };
    };
}
