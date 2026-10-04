{
  description = "Dev shell and canonical deploy app for cloudflare-agent-project (M0 walking skeleton).";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
  inputs.nixpkgs-bun.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs, nixpkgs-bun, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      # omp 18.6.0 engines require bun >= 1.3.14; nixos-25.05 carries 1.2.x.
      bun = nixpkgs-bun.legacyPackages.${system}.bun;

      # Source slice the daemon runtime needs: the three workspace packages on
      # the client import graph (bun executes TS directly) plus the workspace
      # manifests the filtered pnpm install resolves against.
      daemonSrc = pkgs.lib.fileset.toSource {
        root = ./.;
        fileset = pkgs.lib.fileset.unions [
          ./package.json
          ./pnpm-workspace.yaml
          ./pnpm-lock.yaml
          ./tsconfig.base.json
          ./packages/daemon-service
          ./packages/agent-do
          ./packages/protocol
        ];
      };

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

      # U3 daemon client as a runnable closure (ticket #176). Wrapper form:
      # nixpkgs bun + TS source + prod node_modules, NOT `bun build --compile`
      # — compiled standalone binaries SIGSEGV on NixOS (observed on this
      # host, even for hello-world) and the deploy target CT141 is NixOS.
      packages.${system}.daemon = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "cap-daemon";
        version = "0.1.0";
        src = daemonSrc;

        nativeBuildInputs = with pkgs; [
          pnpm_10
          makeWrapper
        ];

        pnpmDeps = pkgs.pnpm.fetchDeps {
          inherit (finalAttrs) pname version src;
          hash = "sha256-HolOql/fka8INGg5kXp6ZnL2vjbYJyxqYPY6WZPJ1n0=";
        };

        dontConfigure = true;

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR/home"
          export XDG_CACHE_HOME="$TMPDIR/cache"
          export npm_config_store_dir="$pnpmDeps"
          pnpm --filter '@cap/daemon-service...' install --prod --offline --frozen-lockfile
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/cap-daemon
          cp -a package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json packages node_modules \
            $out/share/cap-daemon/

          pnpmStore="$out/share/cap-daemon/node_modules/.pnpm"
          # Prune package-graph entries the daemon never imports at runtime
          # (ML embeddings, image codecs, browser/React stacks pulled in by
          # omp's optional features). A dangling node_modules symlink is only
          # fatal if something actually imports it, and the staging smoke
          # gates every closure. Keep @oh-my-pi/pi-catalog: eagerly imported
          # by omp task settings at client boot (observed 2026-10-04).
          # CAUTION: the stdenv build shell runs with nullglob — prune
          # patterns must be absolute glob words (a relative pattern like
          # `onnxruntime-*` silently vanishes: nothing matches under $PWD),
          # and a non-matching absolute pattern drops out of the list.
          # Ship the x86-64 BASELINE native addon variant only (runs on every
          # x86-64 host; AVX2 hosts lose native grep-type speed, not function
          # — the loader's candidate list falls through to baseline).
          for pruneTarget in \
            "$pnpmStore"/onnxruntime-* \
            "$pnpmStore"/@huggingface+transformers@* \
            "$pnpmStore"/@img+sharp-* \
            "$pnpmStore"/sharp-* \
            "$pnpmStore"/lucide-react-* \
            "$pnpmStore"/chromium-bidi-* \
            "$pnpmStore"/react@* \
            "$pnpmStore"/react-dom@* \
            "$pnpmStore"/scheduler@* \
            "$pnpmStore"/sherpa-onnx-* \
            "$pnpmStore"/@oh-my-pi+pi-natives-linux-x64@*/node_modules/@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64-modern.node
          do
            rm -rf "$pruneTarget"
          done
          # Drop node_modules symlinks whose targets were just pruned — the
          # fixup-phase noBrokenSymlinks gate fails the build on intentional
          # dangles, and a dangling link is dead weight either way.
          find "$out/share/cap-daemon/node_modules" -type l -xtype l -delete
          # pnpm's install metadata embeds the fetched store path; keeping it
          # would pull the whole pnpmDeps store (~3.5 GiB) into the closure
          # through the reference scanner. The runtime (bun) never reads it;
          # reinstalls go through the flake source, not the shipped tree.
          rm -f "$out/share/cap-daemon/node_modules/.modules.yaml"

          printf '%s' "${self.shortRev or "dirty"}" > $out/share/cap-daemon/VERSION

          # The wrapper resolves the package root through CAP_DAEMON_ROOT,
          # baked by makeWrapper at install time — a placeholder "out" inside
          # a writeShellScript sub-derivation would resolve to the script's
          # own store path and drag a foreign output into the closure.
          makeWrapper ${
            pkgs.writeShellScript "cap-daemon-inner" ''
              if [[ "''${1:-}" == "--version" ]]; then
                cat "$CAP_DAEMON_ROOT/share/cap-daemon/VERSION"
                echo
                exit 0
              fi
              cd "$CAP_DAEMON_ROOT/share/cap-daemon/packages/daemon-service"
              exec ${bun}/bin/bun run src/client/index.ts "$@"
            ''
          } $out/bin/cap-daemon --set CAP_DAEMON_ROOT "$out"
          makeWrapper ${
            pkgs.writeShellScript "cap-daemon-smoke-inner" ''
              cd "$CAP_DAEMON_ROOT/share/cap-daemon/packages/daemon-service"
              exec ${bun}/bin/bun run scripts/staging-smoke.ts "$@"
            ''
          } $out/bin/cap-daemon-smoke --set CAP_DAEMON_ROOT "$out"

          runHook postInstall
        '';

        meta = with pkgs.lib; {
          description = "CAP daemon client closure — bun + vendored omp tool runtime (U3)";
          platforms = [ "x86_64-linux" ];
        };
      });
    };
}
