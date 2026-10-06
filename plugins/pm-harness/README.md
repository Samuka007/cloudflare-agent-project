# pm-harness — omp plugin (#270)

The PM harness as an **omp custom-tool family**: six model-callable tools over
the AP core (`src/core.ts`, ex `scripts/pm-autopilot.ts`), registered through
the omp custom-tools pipeline into the same registry as the built-ins. With
`tools.xdev` enabled they additionally mount under `xd://pm_*` (the
`xd://github` precedent).

| Tool | Wraps | What it does |
| --- | --- | --- |
| `pm_lane` | `AP.lane` | Gate check (open ∧ Todo ∧ no open blockers) → herdr worktree provision → lane spawn → `blockedBy` edges materialized with the dispatch (#393) → guarded board flip to In Progress. Dry-run default. |
| `pm_apply` | `AP.apply` | The ONLY board write path: preflight diff → batched guarded writes with per-batch re-verify; drift withholds remaining batches. Dry-run default. |
| `pm_audit` | `AP.audit` | Board-vs-reality drift reconcile (read-only); walk-due rule 8 always armed from the repo ledger; prose dependencies without a `blockedBy` edge (#393, rule 9, advisory); returns `pm_apply`-ready repair mutations. |
| `pm_release` | `AP.release` | Browser-lease release (CDP tab/thread discipline) in the append-only ledger. |
| `pm_ledger` | `AP.ledger` | Lease ledger read: full event log + replayed active set. |
| `pm_walk_ledger` | `AP.walkDue` / `AP.walkDone` / `AP.walkLedger` | 走查挂账 ledger (#391): register {ticket, due, face}, settle with evidence, read events + active set. Overdue = audit rule 8 → board flips red (Wait for user). |
| `pm_walk` | `AP.walk` | Acceptance probe (#392): walks a real page — console/page errors, failed requests, selector assertions, screenshot — and writes `.pm-walk/` evidence with a sha256 anchor for the #390 `source:walk` closeout gate. Read-only against the board. |

Bundles one task-agent def: `agents/pm-guard.md` (board guardian; same
guarded-write discipline).

## Install

```sh
# user scope (all projects)
omp plugin link /path/to/cloudflare-agent-project/plugins/pm-harness

# then verify
omp plugin list
```

In any omp session the six tools are then discoverable without any import —
model-callable directly, callable from the eval kernel as
`await tool.pm_lane(310, {}, { confirm: true })`, or mounted as
`xd://pm_lane` under `tools.xdev`.

## AP.walk — the acceptance probe surface (#392)

The discipline "UI: verify actual surface — visual proof" executes HERE, not
in per-ticket improvisation. One call:

```js
const report = await AP.walk(
    "https://cap-server-staging.../settings/plugins/cap-provider-config",
    [{ selector: "[data-testid]", atLeast: 1 }],
    { tabName: "l392-walk" });
report.ok;                 // checks passed ∧ zero console-level errors
report.evidence.anchor;    // ".pm-walk/…/report.json sha256=…" — AP.closeout's
                           //   evidence field consumes this (source:walk)
```

Transport ladder (2026-10-06 user ruling): the eval-kernel `browser` global
(managed headless Chromium) is the preferred surface — probe
`typeof globalThis.browser` before declaring capability missing; explicit
`cdpHttp` opts INTO the raw-CDP Windows Chrome bridge
(`launch-chrome.ps1` + portproxy) for CF Access-gated faces needing the
human-login profile — never a silent default; `allowFetchFallback` degrades
to fetch + raw-HTML checks and the report says `consoleCapture:
"unavailable"` so a gate can reject it for UI evidence.

Evidence layout: `.pm-walk/<UTC stamp>-<url slug>/report.json` (+
`screenshot.<ext>` on browser transports), gitignored, anchor = report path
+ sha256 — the re-checkable closeout reference. First customers: #387/#388
staging plugin-panel acceptance.

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
  src/walk.ts         # AP.walk probe surface (#392): facade → raw-CDP bridge → fetch
  src/tools.ts        # the six custom tools + detached-omp fallback
  src/host-types.ts   # structural omp CustomToolAPI types (no omp dep needed)
  agents/pm-guard.md  # task-agent def (board guardian)
  test/               # L1: core.test.ts (moved), tools.test.ts, fixtures/
```

Config (unchanged from #131): `PM_REPO`, `PM_PROJECT_ID`, `GH_TOKEN` (or
`gh auth token`), `JEV_API_KEY` (intake/file flows only — the tools never
touch jev), `PM_LEASES_PATH`, `PM_CLOSEOUTS_PATH`, `PM_WALKS_PATH`,
`PM_WALK_CDP_HTTP` (forces the raw-CDP walk path session-wide; the Windows
bridge is per-call `cdpHttp` normally).
