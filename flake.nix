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

      # Canonical staging deploy (engineering.md 横切实践 12). Thin credential
      # adapter: the real flow (SPA stage → SERVER_VERSION stamp → deploy)
      # lives in scripts/deploy-staging.sh, shared verbatim with the GHA CD
      # workflow (#175) so local and CD surfaces cannot drift.
      # Usage: nix run .#staging-deploy [-- --skip-spa-build]
      # One combined apps.${system} set — a second dynamic `apps.${system}.…`
      # path in the same attrset is a Nix eval error ("dynamic attribute
      # already defined"), which is how #258's first cut failed flake eval.
      apps.${system} = {
        # Canonical staging deploy (engineering.md 横切实践 12). Thin credential
        # adapter: the real flow (SPA stage → SERVER_VERSION stamp → deploy)
        # lives in scripts/deploy-staging.sh, shared verbatim with the GHA CD
        # workflow (#175) so local and CD surfaces cannot drift.
        # Usage: nix run .#staging-deploy [-- --skip-spa-build]
        staging-deploy = {
          type = "app";
          program = "${pkgs.writeShellApplication {
            name = "deploy-staging";
            runtimeInputs = with pkgs; [
              bash
              git
              gnutar
              gnugrep
              findutils
              coreutils
              nodejs_22
              pnpm_10
            ];
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
              exec bash scripts/deploy-staging.sh "$@"
            '';
          }}/bin/deploy-staging";
        };

        # #258 host onboarding: `nix run github:Samuka007/cloudflare-agent-project#cap-daemon`
        # is what GET /install.sh execs on the joining machine (the Add-a-machine
        # dialog one-liner). apps entry required — `nix run` on the package attr
        # would try bin/daemon (the attr name), which does not exist.
        cap-daemon = {
          type = "app";
          program = "${self.packages.${system}.daemon}/bin/cap-daemon";
        };

        # #337 repro hardening: loop the CI-equivalent apps/server-worker
        # vitest run until the round budget is met or the first red. The real
        # loop lives in scripts/verify-c2-list-window.sh (same thin-adapter
        # pattern as staging-deploy above).
        # Usage: nix run .#verify-c2-list-window [-- --rounds 50]
        verify-c2-list-window = {
          type = "app";
          program = "${pkgs.writeShellApplication {
            name = "verify-c2-list-window";
            runtimeInputs = with pkgs; [
              bash
              git
              gnugrep
              coreutils
              nodejs_22
              pnpm_10
            ];
            text = ''
              REPO_ROOT="$(git rev-parse --show-toplevel)"
              exec bash "$REPO_ROOT/scripts/verify-c2-list-window.sh" "$@"
            '';
          }}/bin/verify-c2-list-window";
        };
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
          # #254: the tool-shell PATH baseline. systemd launches this unit with
          # its compiled-in default PATH (dosfstools/util-linux/openssh/systemd
          # only — measured on CT141, /proc/<pid>/environ), which excludes the
          # NixOS user profile where the host's tools live (nix, git, bash,
          # coreutils). The daemon's Executor and the embedded omp bash tool
          # both inherit this process env verbatim, so agent tool shells saw
          # no host tools at all. Decision (#254): the host user profile IS the
          # agent's tool environment — whitelist it here, in the product
          # wrapper, so every launch method (systemd-run, console, cron)
          # inherits it. NOT bundled-in-closure (nix binds to the host store,
          # ~300 MiB class bloat, wrong layer) and not unit-level env (would
          # only cover one launch method). Entries that don't exist on a given
          # host (non-NixOS Linux) are skipped by name lookup — harmless.
          # Boundary: a tool missing from the host profile is a host install,
          # never a closure addition.
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
          } $out/bin/cap-daemon --set CAP_DAEMON_ROOT "$out" \
            --prefix PATH : /run/current-system/sw/bin \
            --prefix PATH : /run/current-system/sw/sbin \
            --prefix PATH : /nix/var/nix/profiles/default/bin
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
