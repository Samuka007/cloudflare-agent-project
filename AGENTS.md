# Codebase Guidelines

## Commits

- One commit per describable behavior; tests and consumer updates in the same commit.
- Conventional commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.

## Submodule: bb

- `bb/` is a fork of `get-bb/bb` pinned as a git submodule.
- bb-internal work happens in the bb repo (`Samuka007/bb`), on branches pushed to `origin`.
- Never edit bb files directly from this repo's working tree; cd into `bb/` and work there.
- Issues strictly about bb internals live in `Samuka007/bb` issues. Cross-cutting / Cloudflare / design issues live in this repo's issues.

## Agent-Authored Artifacts

When creating an issue or PR body end-to-end, finish the body with exactly:

> AGENT GENERATED: by <model identity>

No leading marker. When only reviewing or commenting on agent-authored work, do not add this line.

## Debugging And QA

- Do not assume. Inspect logs, query state, or call APIs to observe real behavior.

## Shell Output Discipline

- NEVER suffix commands with `| head`, `| tail`, or `2>&1 | tail`. Tooling
  merges stdout/stderr automatically and spills long output to recoverable
  artifacts (`read artifact://<id>`); manual truncation is permanent loss.
- Side-effect commands (deploy, merge, create, migrate) always run bare —
  their output is the only audit trail and cannot be re-run to regenerate.
- If output is long, let the tool spill it, then query the artifact with
  reads/grep. No one-shot pipeline filtering.

## Observation discipline (POMDP)

Your training memory is a **stale belief state**, not the world. Treat it accordingly:

- **Priors are for discussion only.** Any fact that lands in code, rulings, config, or tickets must come from a fresh observation (schema introspection, official docs, live API call) — never from memory alone.
- **Sample before high-cost actions.** The more irreversible the action, the earlier the observation: verify endpoints/protocols against current docs _before_ calling, query the live schema _before_ asserting an API exists.
- **Prior half-life scales with ecosystem velocity**: weeks for fast-moving surfaces (effect, GitHub GraphQL, Cloudflare API), years for stable ones (SQL, HTTP). Confidence must decay to match.
- Known failure modes this rule exists to prevent: calling `/user/tokens/verify` with an account-owned `cfat_` token and concluding "invalid"; guessing GraphQL type names from memory instead of querying `__schema`.

## Agent skills

### Issue tracker

Issues live as GitHub issues on this repo (`Samuka007/cloudflare-agent-project`). bb-internal issues live on `Samuka007/bb`. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Canonical five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` (created lazily). See [docs/agents/domain.md](docs/agents/domain.md).

### Process routing (ask-matt)

Consult `skill://ask-matt` at every stage before choosing how to proceed. It is the router over the engineering flows: the main flow (idea → ship: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement`), the on-ramps (`/wayfinder` for huge foggy efforts, `/triage`, `/diagnosing-bugs`), and phase-boundary rules (`/clear`, `/handoff`, `/compact`, subagents). Do not improvise process; ask the router.
