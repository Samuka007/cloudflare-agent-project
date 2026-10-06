# pm-harness — omp plugin (#270)

The PM harness as an **omp custom-tool family**: five model-callable tools over
the AP core (`src/core.ts`, ex `scripts/pm-autopilot.ts`), registered through
the omp custom-tools pipeline into the same registry as the built-ins. With
`tools.xdev` enabled they additionally mount under `xd://pm_*` (the
`xd://github` precedent).

| Tool | Wraps | What it does |
| --- | --- | --- |
| `pm_lane` | `AP.lane` | Gate check (open ∧ Todo ∧ no open blockers) → herdr worktree provision → lane spawn → `blockedBy` edges materialized with the dispatch (#393) → guarded board flip to In Progress. Dry-run default. |
| `pm_apply` | `AP.apply` | The ONLY board write path: preflight diff → batched guarded writes with per-batch re-verify; drift withholds remaining batches. Dry-run default. |
| `pm_audit` | `AP.audit` | Board-vs-reality drift reconcile (read-only), incl. prose dependencies without a `blockedBy` edge (#393, advisory); returns `pm_apply`-ready repair mutations. |
| `pm_release` | `AP.release` | Browser-lease release (CDP tab/thread discipline) in the append-only ledger. |
| `pm_ledger` | `AP.ledger` | Lease ledger read: full event log + replayed active set. |

Bundles one task-agent def: `agents/pm-guard.md` (board guardian; same
guarded-write discipline).

## Install

```sh
# user scope (all projects)
omp plugin link /path/to/cloudflare-agent-project/plugins/pm-harness

# then verify
omp plugin list
```

In any omp session the five tools are then discoverable without any import —
model-callable directly, callable from the eval kernel as
`await tool.pm_lane(310, {}, { confirm: true })`, or mounted as
`xd://pm_lane` under `tools.xdev`.

## Spawn transport ladder (`pm_lane`)

1. `AP.registerSpawn(fn)` override (tests / custom weaves)
2. eval-kernel `globalThis.agent` (the #200/#206 kernel recipe)
3. **#270 detached fallback**: a detached headless
   `omp -p <lane context> --cwd <worktree>` — stdout/stderr append to
   `<worktree>/.pm-lane.log`; the session persists under `~/.omp/agent/sessions`
   (resumable via `omp --resume`). The tool returns the pid + log path as the
   dispatch receipt.
   Escape hatch: `PM_LANE_NO_DETACH=1` restores the transport-missing contract.

Tests import `src/core.ts` directly and never install the fallback, so the
core's transport-missing L1 assertions are unchanged.

## Layout

```
plugins/pm-harness/
  package.json        # omp manifest: tools → ./src/tools.ts
  src/core.ts         # AP core (#131, relocated #270) — pure fns + injected gh/jev
  src/tools.ts        # the five custom tools + detached-omp fallback
  src/host-types.ts   # structural omp CustomToolAPI types (no omp dep needed)
  agents/pm-guard.md  # task-agent def (board guardian)
  test/               # L1: core.test.ts (moved), tools.test.ts, fixtures/
```

Config (unchanged from #131): `PM_REPO`, `PM_PROJECT_ID`, `GH_TOKEN` (or
`gh auth token`), `JEV_API_KEY` (intake/file flows only — the five tools never
touch jev), `PM_LEASES_PATH`.
