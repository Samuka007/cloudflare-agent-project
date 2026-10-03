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

### Project board

- Project membership is milestone-driven but **not automatic**: `gh issue create` never adds to the board. After any issue create/close/milestone change, run `node scripts/issue-sync.mjs sync` (dry run: `check`, exits 1 on drift). No issue op is complete until `check` reports OK.

## Agent skills

### Issue tracker

Issues live as GitHub issues on this repo (`Samuka007/cloudflare-agent-project`). bb-internal issues live on `Samuka007/bb`. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Canonical five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` (created lazily). See [docs/agents/domain.md](docs/agents/domain.md).

### Process routing (ask-matt)

Consult `skill://ask-matt` at every stage before choosing how to proceed. It is the router over the engineering flows: the main flow (idea → ship: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement`), the on-ramps (`/wayfinder` for huge foggy efforts, `/triage`, `/diagnosing-bugs`), and phase-boundary rules (`/clear`, `/handoff`, `/compact`, subagents). Do not improvise process; ask the router.
