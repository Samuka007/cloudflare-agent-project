# Tracker structure: Linear model → our GitHub mapping

**Status**: research only — no tracker mutations applied. PM decides and applies.
**Date**: 2026-10-04
**Repo ground truth captured via `gh`**: milestones 1–6, labels, project `Cloudflare 边缘个人 agent` (`PVT_kwHOAvgCqs4Blk19`), `.github/workflows/project-board-sync.yml`.

---

## 1. The Linear model (primary sources)

### 1.1 Issue workflow states — and what "Backlog" actually is

Linear issue statuses are **per-team, ordered lifecycle states**. Default set: _Backlog > Todo > In Progress > Done > Canceled_ ([docs/configuring-workflows](https://linear.app/docs/configuring-workflows)).

Statuses live in **fixed-order lifecycle categories**: `Backlog` → `Unstarted` → `Started` → `Completed` → `Canceled` (+ system-managed `Duplicate`). Teams can add/reorder statuses _inside_ a category but cannot reorder categories. The **first Backlog-category status is the default status for new issues** (same page).

Key semantics:

- **Backlog is a per-issue STATE, not a container.** It is the default resting state of every unscheduled issue. Issues in it are tracked and prioritized but not committed to a timebox.
- **Backlog vs Icebox is a distinction _inside_ the Backlog category**, not two containers. Linear's own product team runs the Backlog category with two custom statuses: `Icebox` (never / no current plan) and `Backlog` (maybe soon) — ["How we work at Linear" note, docs/configuring-workflows](https://linear.app/docs/configuring-workflows).
- **Todo carries a time promise**: "Marking an issue status as **Todo** means you plan to start it in the next week or so. Everything else should be in the **Backlog** … The **Backlog** status communicates it's not coming soon. Meanwhile, **Todo** shows it's imminent." ([Descript's internal guide, published by Linear](https://linear.app/now/descript-internal-guide-for-using-linear))
- Canceled/declined work moves to the **Canceled category** (e.g. Won't Fix, Could not reproduce are custom statuses there), not to Backlog — same page; Descript adds a custom `Verify` status in Started for review-before-done.
- Triage is a **separate status category that acts as an intake inbox**, "outside the normal workflow": triage issues are _excluded from all views by default_ ([docs/triage](https://linear.app/docs/triage)). Triage actions: **accept** (→ team default status), **decline** (→ Canceled), **mark duplicate**, **snooze** (hidden until later/new activity; used for "waiting on reporter"). Same source.

### 1.2 Three orthogonal dimensions: state vs timebox vs outcome container

From [docs/conceptual-model](https://linear.app/docs/conceptual-model):

- **Issue workflow states** own _readiness/lifecycle_ (where the issue is in its life).
- **Cycles** own _time commitment_: "Cycles are a team's repeating planning period for issues … plan a set of issues for a fixed period." Cycles are timeboxes "similar to agile-flavored sprints … Unlike sprints, cycles are not tied to releases" ([docs/use-cycles](https://linear.app/docs/use-cycles)). Cycle capacity is estimated from velocity (issues or estimate points over the previous three cycles). Unfinished issues **roll over** automatically; "issues moved to backlog, triage, canceled, or completed during cooldown are not carried into the next cycle" — i.e. states and cycles interact but are distinct axes. An issue can be in Backlog **and belong to no cycle** — that's normal.
- **Projects** own _outcome_: "Projects group issues together around a shared outcome … a feature launch, a customer migration …" ([docs/conceptual-model](https://linear.app/docs/conceptual-model), [docs/projects](https://linear.app/docs/projects)). Projects have their own start/target **timeframes** with granularity by certainty ("year, half-year, quarter, month or precise day").
- **Milestones in Linear are NOT repo-wide phase containers.** They exist _inside a single project_: "Milestones are a concept used to further organize issues **inside an individual project** … meaningful stages of completion for that project" ([docs/conceptual-model](https://linear.app/docs/conceptual-model)). So Linear's "milestone" ≈ our M0–M3 phase breakdown of one project — exactly what our repo milestones already model — and NOT a place to park unrouted issues.
- **Initiatives** sit above projects (strategy roll-up) — not needed at our scale.

**Dimension ownership answer (RQ2)**: _phase commitment_ lives in the **timebox/container axis** (cycle, or project timeframe); _readiness_ lives in the **workflow-state axis** (Backlog → Todo → In Progress → Done). An issue's "not yet scheduled" is expressed by leaving the timebox axis empty while its state stays Backlog — never by inventing a pseudo-container for it.

### 1.3 Status exists at two levels (the parallel the PM suspected)

Issue status (lifecycle) and **project status** (lifecycle of the container) are separate:

- Project statuses are categorized **Backlog / Planned / Started / Completed / Canceled** ([changelog 2024-03-19 custom statuses for projects](https://linear.app/changelog/custom-statuses-for-projects); [docs/project-status](https://linear.app/docs/project-status) — "Project statuses clarify where each project is in its lifecycle", customizable within those categories).
- A project in status _Backlog_ is an outcome container that hasn't started — its issues inside may individually sit in Backlog or Todo. Two levels, same vocabulary, deliberately separate.

### 1.4 Documented practice (what teams actually do)

Descript's guide ([linear.app/now](https://linear.app/now/descript-internal-guide-for-using-linear)):

- Weekly promotion pass: "The first thing you do each week should be to go through all the issues assigned to you in your backlog and promote a manageable number to **Todo**."
- Don't dump things in Todo to be polite: assigning someone an issue directly into Todo "is tantamount to declaring that they'll be working on it this week" — put it in **Triage** instead.
- Blocked/unscheduled work: mark `Is blocked by`, or move back to Backlog **with a reminder**; use **priority, not fake due dates**, to rank backlog items.
- "Everything else should be in the Backlog" — Backlog is the healthy default, not a failure state.

---

## 2. GitHub primitives and the translation (RQ4)

### 2.1 What GitHub gives us

| Primitive         | Nature                                                                                                                                                                  | Source                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue open/closed | Binary lifecycle only; no built-in state machine                                                                                                                        | [About issues] via [best practices](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects)                                                                                                                       |
| Milestones        | Progress tracker for a **group of issues/PRs with a due date and completion percentage**; prioritize by drag; >500 open issues breaks ordering                          | [About milestones](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/about-milestones)                                                                                                                                                                     |
| Projects V2       | Adaptable table/board/roadmap; **custom single-select fields**; built-in workflows (e.g. set Status **Done** on close, set Status on add); auto-add by filter; insights | [About Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects), [Built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations) |

GitHub's own best-practices doc explicitly blesses the pieces we need:

- "Views allow you to **manage your team backlog**, weekly iterations, team roadmaps…" and "customizing views … e.g. filtering by status to view all un-started items", "column limit to maintain focus" — i.e. **backlog is a board column/view of a Status-style field**, not a container.
- "Use a **single select field** to track information … for example, track priority or **project phase**."
- "**Have a single source of truth** … track a target ship date in a single location" — projects auto-sync built-in metadata (assignee, milestone, labels).

### 2.2 Where should "backlog" live? Three options, one right

| Option                                      | Fits Linear semantics?                                                                                                 | Trade-offs                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects V2 `Status` value `Backlog`** ✅ | Yes — backlog as lifecycle state; board column; sortable/prioritizable in the board view exactly like Linear's Backlog | Requires adding the option + a default-on-add rule (one-time board config)                                                                                                                  |
| Label `backlog` ❌                          | No — labels are flat, multi-valued, unordered                                                                          | Mixes lifecycle into the label axis; can't be the _default_ state; competes with triage labels on the same issue                                                                            |
| Milestone `待路由（backlog）` ❌            | No — milestones are **due-date progress containers** with a completion %                                               | A "backlog milestone" has no due date and never completes → permanently 0% noise; membership is the only signal it carries; conflates container with state (the exact smell the PM flagged) |

Verdict: **Backlog is a `Status` option on the Projects V2 board.** Milestones stay phase commitments (equivalent to Linear's _project milestones_: "meaningful stages of completion"), which matches the PM's standing ruling.

---

## 3. Verdict for this repo (RQ5) — recommended structure

### 3.0 Current state (observed 2026-10-04)

- Milestones: `M0 骨架`, `M1 可用性硬化`, `M2 存量迁移`, `M3 生态扩展` (phase commitments ✅), `规划（Charter）` (closed history ✅), **`待路由（backlog）` #6 containing exactly #33, #48** ❌.
- Board `Cloudflare 边缘个人 agent`: `Status` field = **`Todo` / `In Progress` / `Done` only** — no Backlog, no Canceled.
- `.github/workflows/project-board-sync.yml`: milestone-carrying issues → board, Status = `Todo` (open) / `Done` (closed); **milestone-less issues stay off the board by design**. Listens on `issues: [opened, reopened, closed, milestoned]` — **`demilestoned` is missing**, so a de-milestoned issue leaves a stale board item.
- Futurework #24/#25: milestone-less (deliberate) → currently invisible on the board.

### 3.1 Target model: three orthogonal axes

| Axis                            | Carrier (ours)                                                                                          | Linear analog                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Lifecycle / readiness**       | Board `Status`: **`Backlog` → `Todo` → `In Progress` → `Done` / `Canceled`**                            | Issue workflow states                                           |
| **Phase commitment**            | Milestones `M0`–`M3` (+ `规划（Charter）` as closed history). Milestone-less = deliberately unscheduled | Cycles / project milestones ("meaningful stages of completion") |
| **Intake & executor readiness** | Labels `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix` (+ `type:*`)   | Triage category (inbox, outside the workflow) + custom statuses |

### 3.2 Answers

**(a) Dissolve `待路由`?** Yes. It is a state masquerading as a container: it never gets a due date, never completes (permanent 0%), and duplicates what a `Backlog` column does natively. Replace with board `Status = Backlog`.

**(b) Where do #24/#25 (futurework) and #33/#48 (committed-unrouted) live?**
All four: **on the board, `Status = Backlog`, no milestone.** The old milestone's only extra bit — "committed but unrouted" vs "raw idea" — is already carried by the issues' own titles/`type:*` labels (`type:decision`). If the PM wants to preserve the distinction mechanically, do it with a **label** (`route:deferred`), never a milestone. Linear analog: Backlog status + no cycle; Descript's rule "everything else should be in the Backlog" — with Icebox as the optional sub-state for #24/#25 if the PM later wants never/someday separation (a second Status option like `Icebox` inside the Backlog _category_).

**(c) Triage-label flow vs Linear Triage?** The mapping is clean; **keep labels, don't invent board statuses** for them:

| Ours                                  | Linear analog                    | Action                                                                                                       |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `needs-triage`                        | Triage inbox (accept pending)    | Keep; board view filtered on it = "Triage view"                                                              |
| `needs-info`                          | Snoozed awaiting reporter        | Keep                                                                                                         |
| `ready-for-agent` / `ready-for-human` | Accepted → Todo (+ who executes) | Keep as labels; on promotion, board Status → `Todo`. They're orthogonal to lifecycle (executor type ≠ state) |
| `wontfix`                             | Decline → Canceled               | Keep label; when the issue is closed, workflow sets `Canceled`                                               |

Label-hygiene observation (out of scope, flag only): `status:awaiting-user` ≈ `needs-info` and `status:agent-ready` ≈ `ready-for-agent` look like duplicate vocabularies from two eras; consider consolidating to the 5-role set.

**(d) Does `project-board-sync.yml` need changing?** Yes, three changes:

1. **`demilestoned`** event added — otherwise the board shows stale `Todo` for de-milestoned issues (real bug today; fatal once Backlog is board-mediated).
2. **Milestone-less issues board as `Backlog`** instead of being skipped — the board becomes the single lifecycle surface ("single source of truth", per GitHub best practices) and #24/#25/#33/#48 get homes without any pseudo-milestone.
3. **Closed + `wontfix` label → `Canceled`** — Linear distinguishes Done from Canceled; our `wontfix` issues shouldn't inflate a "Done" column.

Trade-off accepted: the board gets every repo issue (noise). Mitigation is GitHub-native: saved views (e.g. _Active_ = Status≠Done/Canceled grouped by Milestone; _Backlog_ = Status=Backlog grouped by `type:*`) and a column limit — both recommended by GitHub's best-practices page.

---

## 4. Migration diff (recommendation — NOT applied)

### 4.1 Board: add `Backlog` + `Canceled` to `Status`

⚠️ `updateProjectV2Field` with `singleSelectOptions` **replaces the whole option set** (schema: `UpdateProjectV2FieldInput.singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput {id, name, color, description}]`), so the script fetches existing options first and merges:

```bash
# 1. Fetch current Status field options
gh api graphql -f query='query{node(id:"PVT_kwHOAvgCqs4Blk19"){... on ProjectV2{field(name:"Status"){... on ProjectV2SingleSelectField{id options{name color description}}}}}}' \
  --jq '.data.node.field' > /tmp/status-field.json

# 2. Merge (existing preserved verbatim + Backlog + Canceled) and update
jq '{query: "mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) { updateProjectV2Field(input: {fieldId: $fieldId, singleSelectOptions: $options}) { projectV2Field { ... on ProjectV2SingleSelectField { options { name } } } } }",
     variables: { fieldId: .id,
                  options: (.options + [
                    {name: "Backlog",  color: "GRAY", description: "Unscheduled / unrouted"},
                    {name: "Canceled", color: "RED",  description: "Declined / wontfix"}
                  ]) }}' /tmp/status-field.json \
| gh api graphql --input -
```

Note: our sync Action resolves options **by name at runtime** (`options.find(o => o.name === desiredState)`), so option-id churn is harmless.

### 4.2 Milestone: empty then delete `待路由` (#6)

```bash
gh issue edit 33 --remove-milestone --repo Samuka007/cloudflare-agent-project
gh issue edit 48 --remove-milestone --repo Samuka007/cloudflare-agent-project
gh api -X DELETE repos/Samuka007/cloudflare-agent-project/milestones/6   # unassigns any stragglers, deletes milestone
```

The two issues then land on the board as `Backlog` via the updated workflow (or manually: `gh project item-add 5 --owner Samuka007 --url <issue-url>` + set Status once).

### 4.3 Workflow patch (`.github/workflows/project-board-sync.yml`)

```diff
 on:
   issues:
-    types: [opened, reopened, closed, milestoned]
+    types: [opened, reopened, closed, milestoned, demilestoned]
```

```diff
-            if (!issue.milestone) {
-              core.info(`Issue #${issue.number} has no milestone; staying off the board.`);
-              return;
-            }
-
-            const desiredState = issue.state === 'closed' ? 'Done' : 'Todo';
+            // Lifecycle: every issue lives on the board (Linear-style Backlog default).
+            const desiredState = issue.state === 'closed'
+              ? (issue.labels?.some((l) => l.name === 'wontfix') ? 'Canceled' : 'Done')
+              : (issue.milestone ? 'Todo' : 'Backlog');
+            if (!issue.milestone) {
+              core.info(`Issue #${issue.number} has no milestone; Status=Backlog.`);
+            }
```

…and update the header comment ("Milestone-less issues stay off the board by design (backlog)" → "Milestone-less issues board as Backlog; milestone add promotes to Todo").

### 4.4 Sequencing

1. Board options (4.1) → 2. workflow patch (4.3) → 3. de-milestone + delete (4.2). Order matters so removed milestones immediately resolve to Backlog on the already-patched workflow.
2. Create saved views: _Active_ (filter `Status ≠ Done, Canceled`, group by Milestone), _Backlog_ (filter `Status = Backlog`, group by label `type:*`), _Triage_ (filter label `needs-triage`).

### 4.5 What deliberately does NOT change

- Milestones M0–M3 + `规划（Charter）`: keep as phase commitments (PM ruling; matches Linear's in-project milestones concept).
- 5-role triage labels and `type:*`/`scope:*`: keep.
- Two-default built-in board workflows (close→Done, PR merged→Done): harmless; our Action sets the same or Canceled. Optionally disable "close→Done" to avoid double-write races with the Action.

---

## 5. Sources

Linear primary docs:

- Workflow states / categories / default status / Icebox note / triage category: https://linear.app/docs/configuring-workflows
- Conceptual model (issues, teams, projects, milestones-inside-projects, cycles, initiatives): https://linear.app/docs/conceptual-model
- Triage inbox (accept/decline/duplicate/snooze, outside normal workflow): https://linear.app/docs/triage
- Cycles (timeboxes, rollover, capacity/estimates): https://linear.app/docs/use-cycles
- Projects (outcome containers, timeframes, ongoing-work FAQ): https://linear.app/docs/projects
- Project status lifecycle: https://linear.app/docs/project-status
- Project status categories Backlog/Planned/Started/Completed/Canceled: https://linear.app/changelog/custom-statuses-for-projects

Practice write-ups:

- Descript's internal guide (Todo ≈ next week; Backlog default; weekly promotion; Triage on assign; Verify status): https://linear.app/now/descript-internal-guide-for-using-linear

GitHub primary docs:

- About milestones (due date, completion %): https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/about-milestones
- About Projects (custom fields, flexible methodology): https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects
- Best practices for Projects (manage backlog via views; single-select for phase; single source of truth; column limits): https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects
- Built-in automations (status on add/close): https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations

Repo observations (via `gh`, 2026-10-04): milestone list/counts; milestone #6 contents (#33, #48); #24/#25 labels+no-milestone; project `PVT_kwHOAvgCqs4Blk19` Status options (Todo/In Progress/Done) and enabled workflows; `project-board-sync.yml` event list and scripting.

---

## 6. Addendum (2026-10-04, PM ruling during #53 execution): Priority is a board field

Linear models Priority as an **issue property** (not a container, not a lifecycle state): it ranks
work inside Backlog/Todo without faking due dates (§1.4: "use priority, not fake due dates, to rank
backlog items"). This repo already carries priority as `priority:p0|p1|p2` labels. PM ruling: keep
the label as the **input surface** (visible on the issue page, where triage and editing happen) and
add a **board `Priority` single-select field as the canonical mirror** for board sort/filter — a
label column cannot drive board grouping/sorting the way a real field can.

| Concern         | Carrier                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| Input surface   | `priority:p0` / `priority:p1` / `priority:p2` issue labels                               |
| Board field     | ProjectV2 single-select `Priority` = `P0` (RED) / `P1` (ORANGE) / `P2` (GRAY)            |
| Sync direction  | **One-way, labels → field**; no back-sync (field edits never rewrite labels)             |
| Sync trigger    | Every subscribed `issues` event mirrors the label; no `priority:*` label → field cleared |
| Backlog ranking | Backlog / Active saved views group/sort by `Priority`                                    |

Rationale: the issue page is where humans read and edit an issue, so the label stays the editing
surface; the board is where sorting and filtering happen, so the field is the reading surface.
A two-way sync would need label-event handling on a second axis and invites drift; mirroring the
authoritative labels one-way keeps a single source of truth.
