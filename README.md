# cloudflare-agent-project

Personal agent loop on Cloudflare edge — the loop lives on workerd, tools live on enrolled machines. bb (fork) rides as a submodule for UX / event-model / thread-model leverage.

## Layout

- `bb/` — fork of get-bb/bb as git submodule (UX, thread/event model, server-contract). Issues strictly about bb internals live in `Samuka007/bb`.
- `apps/` — deployable apps (worker-agent, future server-on-Workers, etc.).
- `packages/` — shared TS packages (protocol, domain, client).
- `plugins/` — bb plugins that bridge bb ↔ worker agent.
- `docs/` — architecture, ADRs, agent-skill configs.

## Tracking

- bb-internal issues → `Samuka007/bb` issues (label `wayfinder:*` etc.).
- Cloudflare / design / cross-cutting issues → this repo's issues.
- GitHub Project for cross-repo scope view: see `docs/agents/project-management.md`.
