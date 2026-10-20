# cloudflare-agent-project

Personal agent loop on Cloudflare edge — the loop lives on workerd, tools live on enrolled machines. bb (fork) rides as a submodule for UX / event-model / thread-model leverage.

## Layout

- `bb/` — fork of get-bb/bb as git submodule (UX, thread/event model, server-contract). Issues strictly about bb internals live in `Samuka007/bb`.
- `apps/` — deployable apps (worker-agent, future server-on-Workers, etc.).
- `packages/` — shared TS packages (protocol, domain, client).
- `plugins/` — bb plugins that bridge bb ↔ worker agent.
- `docs/` — architecture, ADRs, agent-skill configs.

## Getting started

From a fresh clone, one command brings the repo to a green baseline:

```sh
pnpm bootstrap
```

It initializes the `bb`/`pm-autopilot` submodules, installs dependencies with
the frozen lockfile (this also installs the husky pre-commit hook), and builds
the bb dist packages that typecheck consumes — the same order CI runs. Then
the usual gates:

```sh
pnpm typecheck && pnpm lint
```

`pnpm lint` runs eslint once per workspace scope (`scripts/lint-split.mjs`):
type-aware linting of the whole monorepo in a single eslint process keeps
every project's TypeScript program in memory at once and gets OOM-killed on
memory-constrained dev boxes (exit 143).

## Tracking

- bb-internal issues → `Samuka007/bb` issues (label `wayfinder:*` etc.).
- Cloudflare / design / cross-cutting issues → this repo's issues.
- GitHub Project for cross-repo scope view: see `docs/agents/project-management.md`.
