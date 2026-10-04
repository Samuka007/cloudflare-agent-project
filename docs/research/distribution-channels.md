# Distribution channels: local-built closures → remote NixOS (facts & costs)

Research for #164, feeding the #162 CD map ("release 通道形态" was listed as
not-yet-specified pending R1/R2 facts). Facts and costs only — **no channel
selection is made here** (that ruling stays with #162 / the user).

Constraint it must serve (user ruling 2026-10-04, #162 Notes):
**remote-is-thin-consumer** — the remote NixOS (first target: cap-verify LXC,
PVE CT141, quota 2C/4G/40G) only *executes* closures built on the local
machine; it never evaluates and never builds. Any channel that makes the
remote build is a ticket-level violation of #162.

Truth sources:

- `skill://nixos-lxc-appliance-pve` §3/§4/§5 — proven deploy chain on the
  house PVE host (dragonos-stack), verified live 2026-09-29.
- `nixos-rebuild(8)` man page read on this NixOS box 2026-10-04
  (nixos-rebuild-ng era; contains `--elevate`, `--store-path`, `build-image`).
- Nix manual: `nix copy` (nix.dev/manual/nix/2.24 …/nix3-copy),
  `nix-copy-closure`, flake references + lock files (NixOS/nix `src/nix/flake.md`).
- Attic docs: docs.attic.rs/tutorial + zhaofengli/attic README (fetched 2026-10-04).
- Cachix pricing page cachix.org/pricing (fetched 2026-10-04).
- GitHub docs: about-releases asset limits (fetched 2026-10-04).
- Measured on this box 2026-10-04: toplevel closure of the reference minimal
  appliance (`nix-personal-config-test#pve-warpgate`, the skill's working
  example) via `nix path-info -Sh/-r`.

---

## 0. The measured anchor

Every cost below scales with the system closure, so it was measured instead of
guessed:

```
nix path-info -Sh .#nixosConfigurations.pve-warpgate.config.system.build.toplevel
→ /nix/store/bcyy…-nixos-system-unnamed-lxc-proxmox-26.11.20260929.b4fd65b   1.5 GiB
nix path-info -r … | wc -l → 604 store paths
```

A minimal (Warpgate gateway) NixOS 26.11 appliance closure is **1.5 GiB /
604 paths**. [MEASURED 2026-10-04]. First-ever deploy of any channel moves at
least the missing subset of this; the cap-verify 40 G disk and the 1.5 GiB
per-generation footprint bound how many generations/GC policy the remote can
carry.

## 1. Channel A — `nixos-rebuild --target-host` closure copy (skill-proven)

Mechanics (man page + skill §4, both verified):

- `nixos-rebuild --flake .#<host> --target-host <user@ip> [--build-host
  nixos-pve] switch` — evaluation and build happen on the invoking/build
  machine; the resulting toplevel closure is copied to the target store
  (`nix copy` under the hood); activation (`switch-to-configuration`) runs on
  the target. The target needs ssh reachability and **root** (or delegated
  elevation). [live doc + skill §4]
- `--build-host` builds on the named ssh host; without `--target-host` the
  result is copied back to the local machine. [live doc]
- `--use-remote-sudo` is now a **deprecated alias** of `--elevate=sudo`; skill
  §4's `samuka@` target therefore maps to `--elevate=sudo`. [live doc]
- `--use-substitutes` adds `--use-substitutes` to each `nix copy` call — the
  *target* then pulls any path it can from its own substituters
  (cache.nixos.org) and only our private paths cross the ssh link. Man page
  spells out the intended case: "useful when the target-host connection to
  cache.nixos.org is faster than the connection between hosts". [live doc;
  same flag as `nix copy --substitute-on-destination`, Nix manual]
- `nix copy` between stores copies **only paths missing on the destination**
  (closure diffing at store-path granularity, content-addressed so unchanged
  paths are skipped). [Nix manual, `nix copy` / `nix-copy-closure`]
- `--store-path <path>`: activate a **pre-built** system closure, skipping
  evaluation+build entirely — man page names CI-built closures as the use
  case. This is the primitive that decouples "who built it" from "who
  activates it" while staying inside nixos-rebuild. [live doc]

Costs:

| Cost | Value / shape |
|---|---|
| New infrastructure | **zero** |
| First deploy transfer | up to full closure ≈ 1.5 GiB over ssh [MEASURED size; transfer over house LAN] |
| Steady-state transfer | only missing store paths per deploy; proportional to the diff between generations [live-doc mechanism; typical delta size UNMEASURED → [INFERENCE]: tens–hundreds of MiB for a server config, dominated by nixpkgs bumps] |
| With `--use-substitutes` | ssh link carries only paths absent from cache.nixos.org — i.e. mostly our own store paths [live-doc mechanism; saving UNMEASURED → [INFERENCE]: majority of a routine deploy] |
| Remote disk | store grows per deploy; old **generations pin their closures** until GC (`nix-collect-garbage -d` / `nix store gc`); 40 G disk + 1.5 GiB worst-case-per-full-bump ⇒ dozens of generations before pressure [INFERENCE — no generation-count policy measured] |
| Remote CPU/RAM | none at deploy time beyond unpacking store paths + systemd activation — thin-consumer compatible (skill §4 verified live on CT119/CT140 class hardware) |
| Auth surface | one ssh key from build host → target root (or sudo-elevated user); first deploy of a fresh image relies on baked `authorizedKeys` [skill §4] |
| Failure modes | target unreachable from build host (ssh-only path); crossSystem must match target arch [live doc]; store-path copy needs `nix-store --serve`-capable nix on target — NixOS appliance ships it [INFERENCE from skill §3: store binaries present] |

Notes that carry over from the skill: the CT119 build machine already holds a
warm store cache (skill §4 uses it as `--build-host`); socket units may not
restart on switch (skill §5).

## 2. Channel B — binary cache as transport

A binary cache replaces the ssh push with: push once to a cache → every
consumer (remote, CI, second box) pulls missing paths over HTTP. Three
options were scoped by #164:

### B1. none — channel A *is* the transport

- Facts: nothing to add; §1 covers it. `nix copy` also has non-ssh
  destinations if ever needed: `file://` (chroot store — **not** a binary
  cache layout), `s3://` (S3-compatible bucket; needs Nix built with AWS
  support). [Nix manual]
- Costs: zero infra; per-deploy bandwidth = missing-paths delta over ssh;
  no sharing between machines/CI beyond the build host itself; history lives
  only in the two stores.

### B2. attic, self-hosted

Facts (docs.attic.rs, README):

- Single Rust server binary (`atticd`); **monolithic mode** runs with SQLite +
  local-filesystem storage out of the box ("a simple setup using SQLite and
  local storage has been configured for you"). Production layout: split
  `api-server` (stateless, replicable) + `garbage-collector` (periodic, not
  replicable), PostgreSQL + S3-compatible storage, HTTPS behind nginx/LB.
- **Content-addressed global dedup, chunk-level**: the NAR is split into
  chunks; identical chunks across all caches/versions are stored once.
- Push skips paths already known from configured **upstream caches** (default
  demo skips `cache.nixos.org`) — the cache only stores private paths.
- Consumer side = plain Nix substituter: `attic use` writes
  `substituters` + `trusted-public-keys` (+ token) into nix.conf; pulls need
  the user trusted by `nix-daemon` (or root/nix-daemon pulls).
- Auth: stateless signed JWTs with per-cache permissions (`atticadm
  make-token --sub … --pull … --push …`); caches can be public
  (unauthenticated pull) or private.
- GC: per-cache `--retention-period` (objects unused for N time become
  eligible); three-level GC (cache mapping → global NAR → global chunks).
- Maturity caveat printed in its own docs: "Attic is an early prototype and
  everything is subject to change… you might even be required to reset the
  entire database."

Costs:

| Cost | Value / shape |
|---|---|
| New infrastructure | one always-on service + its storage volume. Placement freedom: PVE host (62 G free root disk per #162 probing) or any CT. Resource need UNMEASURED → [INFERENCE]: static binary + SQLite mode is modest (idle RSS order of a few dozen MB, plus stored chunks); no source states a floor |
| Storage | chunk-dedup'd private paths only (upstream skip); across N appliance versions the same chunk (e.g. unchanged nixpkgs paths) is stored once [mechanism per docs; realized ratio UNMEASURED → [INFERENCE]: high across versions that share a nixpkgs rev] |
| Deploy-time transfer | consumer fetches only missing paths over HTTP(S), parallel — replaces the ssh push; works regardless of who initiates (CI pushes, remote pulls) |
| Configuration surface | substituter URL + public key (+ token) on consumer; HTTPS endpoint; GC retention policy; JWT minting for CI |
| Operational risk | one more component in the deploy path (cache down ⇒ consumers can't substitute; direct ssh copy in §1 remains available as bypass [INFERENCE — not exercised]); GC mispolicy can evict paths a rollback needs (retention period is per-cache) |
| Versioning of artifacts | implicit — store paths are content-addressed; a "release" is the closure set pushed under its tag |

### B3. cachix, hosted

Facts (cachix.org/pricing, fetched 2026-10-04):

- Free tier: **5 GB for open-source projects** + 20 Cachix Deploy agents.
  (Blog 2026-01: organizations also got a 5 GB free plan.)
- Paid tiers: Starter 50 GiB / Standard 250 GiB / Pro 1500 GiB, CloudFlare
  CDN, **unlimited bandwidth** — pricing is "contact us" on the current page
  (2023 blog listed $ values; current page does not). 14-day trial.
- Storage: entries are **compressed** ("saves up to 90%"); cache.nixos.org
  entries are never stored; at 85% of quota a warning email, at 100%
  **least-recently-used entries are removed**.
- Public vs private caches: the free 5 GB is scoped to open-source (public)
  caches; private caches are a paid feature [pricing page scopes free tier to
  "open source projects"; private-cache gating stated on plan pages/docs →
  treat as [live doc + INFERENCE] until a private cache is actually created].

Costs:

| Cost | Value / shape |
|---|---|
| New infrastructure | zero (hosted); minutes to wire |
| Money | $0 only if the cache is public/open-source; private ⇒ paid plan, price on inquiry (2026-10 page) |
| Opsec for this repo | this is a **private personal-infra repo**; a public cache exposes every pushed path name/narinfo to anonymous pullers [INFERENCE on severity — path names leak config/package inventory, not contents] |
| Storage | 5 GiB quota, LRU-evicted at limit — evicted old releases break byte-exact rollback after the fact |
| Deploy-time transfer | same substituter mechanics as B2 (CDN-fronted) |
| Lock-in | cache contents migratable via `nix copy` from/to any store; token/account is the binding dependency |

## 3. Versioned release: minimal forms

### R1. git tag + flake ref (source-pointer release)

- `nixos-rebuild --flake github:Samuka007/cloudflare-agent-project/<tag>#cap-verify …`
  is valid flake-ref syntax: `github:<owner>/<repo>/(<ref>|<rev>)` — branch,
  tag or commit in the third segment; `git+https://…?ref=refs/tags/0.18.0`
  is the explicit-tag spelling. [Nix flake.md, URL-like examples]
- Reproducibility comes from the **committed `flake.lock`**: locked nodes pin
  `rev` + `narHash` per input, and "the main reason for these attributes is
  to allow flake inputs to be substituted from a binary cache". A tag whose
  tree contains its lock file is a complete source-side version pin.
  [Nix flake.md, Lock files]
- Evaluation and build happen wherever the deploy command runs (build host) —
  the remote stays thin. Man page: `--flake` + `--target-host` chain (§1).
- `nixos-rebuild` honors the flake's locked inputs; skill §5 trap: version
  checks must eval through the flake, not the registry nixpkgs.

Costs:

| Cost | Value / shape |
|---|---|
| Storage | zero extra — git history *is* the artifact store |
| Per-deploy work | full evaluate+build on the build host each deploy (fast with warm store cache; CT119/本机 already warm per skill §4) |
| Network at deploy | must fetch the flake source from GitHub + any unlocked inputs (none if lock committed) |
| Byte-exactness | outputs are content-addressed; same tag + same store ⇒ same bytes. **No archived bytes**: if the local store cache is lost, re-deploying an old tag re-fetches inputs pinned by `narHash` (GitHub + cache.nixos.org availability required) and rebuilds |
| Rollback | redeploy the older tag (or `--rollback` one generation on the target — man page) |
| Bootstrapping | the *first* provisioning of a fresh CT is not covered by a flake ref alone — needs the image tarball path (skill §2) or manual nix install [INFERENCE from skill §3/§4 flow] |

### R2. artifact archive (bytes shipped)

Forms, smallest to heaviest:

1. **Closure archive**: `nix copy --to file:///srv/releases/<tag> <toplevel>`
   (chroot-store tree) or `nix-store --export $(nix-store -qR <toplevel>)`
   piped through a compressor → single-file closure; restored via
   `nix-store --import` / `nix copy --from file://…`. [Nix manual: file:// is
   a copyable store, `--no-check-sigs` exists for unsigned targets]
2. **Image tarball**: `nix build
   .#nixosConfigurations.<host>.config.system.build.images.proxmox-lxc` →
   `result/tarball/*.tar.zst` (skill §2, verified 2026-09-29); newer
   `nixos-rebuild build-image --image-variant proxmox` is now a first-class
   action. [live man page] Full appliance image — deploy means recreate the
   CT with `pct create`, not in-place switch.
3. Host for the bytes: **GitHub Release assets** — ≤ **2 GiB per file**,
   ≤ 1000 assets, no total-size/bandwidth limit [docs.github.com
   about-releases]; community reports of uploads hanging near the 2 GiB
   boundary exist [GitHub community discussion #170005].

Costs:

| Cost | Value / shape |
|---|---|
| Size per release | closure-size bound: ~1.5 GiB raw for the reference appliance [MEASURED]; compressed smaller [compressible fraction UNMEASURED → [INFERENCE]: NAR of mostly-ELF+text compresses well, expect order 500–800 MiB zstd] — fits the 2 GiB/file GitHub limit for minimal appliances, marginal for heavier systems |
| Per-deploy work | CI builds once at tag time; deploys do **no evaluation/build** anywhere — strongest thin-consumer fit |
| Rollback | byte-exact: re-import/re-copy the archived closure of tag N-1; immune to GitHub/cache.nixos.org drift (subject to the archive's own retention) |
| Extra moving parts | release CI (build → archive → upload), storage lifecycle (GitHub releases: no limit, manual pruning; attic: GC policy), and an import step on the consumer side |
| Bootstrapping | image tarball (form 2) is the only form that provisions a fresh CT end-to-end without nix tooling on the operator side [INFERENCE from skill §2/§3: pct create consumes the tarball directly] |

### R3. hybrid — tag as pointer, cache as bytes

- Facts: the two mechanisms compose without new primitives — tag pins
  source+lock (R1), a binary cache (B2/B3) carries the built bytes; the
  `narHash` in the committed lock is what lets inputs themselves be pulled
  from a cache [Nix flake.md]. CI builds the tag, pushes the closure to the
  cache, and the remote pulls missing paths as a substituter; activation can
  be driven with `--store-path` on a pre-built closure [man page].
- Costs: sum of R1 (zero storage) + B2/B3 (cache infra/quota); deploy-time
  rebuild only when the cache misses; byte-exactness bounded by cache
  retention (attic GC / cachix LRU).

## 4. Thin-consumer fit matrix

| Channel | Remote evaluates? | Remote builds? | Remote needs | #162 ruling fit |
|---|---|---|---|---|
| A: `--target-host` copy | no (eval on build host) | no | ssh from build host, root/elevated, nix present | **fits** (skill-proven live) |
| B1: none (=A) | no | no | same as A | **fits** |
| B2/B3: binary cache | no | no | HTTPS egress + substituter config | **fits** (pull replaces push) |
| R1: tag + flake ref | no, *if deploy command runs on build host*; remote eval would violate | no | nothing beyond A | **fits** only as long as the flake ref is consumed by the build host, never by the target |
| R2: artifact archive | no | no | import/copy step | **fits**; image-tarball form is the bootstrap path |
| R3: hybrid | no | no | substituter config | **fits** |

Anti-pattern to name explicitly (ticket-level violation of #162): pointing
the **target** at `github:…#host` and running `nixos-rebuild switch` there —
that moves evaluation+build onto the 2C/4G quota box.

## 5. Evidence register

- [MEASURED 2026-10-04] appliance toplevel closure 1.5 GiB / 604 paths
  (`nix path-info`, pve-warpgate, nixpkgs 26.11.20260929) — this box.
- [live doc] `nixos-rebuild(8)` — local NixOS man page, 2026-10-04
  (`--target-host`/`--build-host`/`--use-substitutes`/`--store-path`/
  `--elevate` deprecating `--use-remote-sudo`/`build-image`).
- [live doc] Nix manual 2.24: `nix copy` (missing-paths copy,
  `--substitute-on-destination`, `file://` vs `s3://`), `nix-copy-closure`.
- [live doc] NixOS/nix `src/nix/flake.md`: flake-ref URL forms
  (`github:o/r/<ref|rev>`, `?ref=refs/tags/…`), lock-file `rev`+`narHash`
  pinning, narHash⇒cache-substitutability of inputs.
- [live doc, fetched 2026-10-04] docs.attic.rs/tutorial + zhaofengli/attic
  README: monolithic SQLite+local mode, chunk-level global dedup, upstream
  skip, JWT auth, retention GC, api-server/GC split, early-prototype caveat.
- [live doc, fetched 2026-10-04] cachix.org/pricing: 5 GB free (open source),
  50/250/1500 GiB plans (contact pricing), compressed entries, LRU eviction,
  CDN, unlimited bandwidth.
- [live doc, fetched 2026-10-04] docs.github.com about-releases: ≤2 GiB per
  release asset, ≤1000 assets, no total limit.
- [skill] `skill://nixos-lxc-appliance-pve` §2 (proxmox-lxc image tarball),
  §4 (proven `--target-host`/`--build-host nixos-pve` chain, remote-sudo,
  first-deploy ssh), §5 (flake-vs-registry eval trap).
- [INFERENCE] items flagged inline: steady-state transfer delta, attic idle
  resource floor, dedup realized ratio, closure compression ratio, remote
  generation-retention pressure on 40 G, free-tier private-cache gating for
  cachix, opsec severity of a public cache, R1 bootstrap gap.
