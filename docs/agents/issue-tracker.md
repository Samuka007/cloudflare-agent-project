# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues **on `Samuka007/cloudflare-agent-project`**. Use the `gh` CLI for all operations; pass `-R Samuka007/cloudflare-agent-project` explicitly.

bb-internal issues live on `Samuka007/bb` (see that repo's own `docs/agents/issue-tracker.md`).

## Conventions

- **Create an issue**: `gh issue create -R Samuka007/cloudflare-agent-project --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R Samuka007/cloudflare-agent-project --comments`.
- **List issues**: `gh issue list -R Samuka007/cloudflare-agent-project --state open --json number,title,body,labels,comments`.
- **Comment on an issue**: `gh issue comment <number> -R Samuka007/cloudflare-agent-project --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> -R Samuka007/cloudflare-agent-project --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> -R Samuka007/cloudflare-agent-project --comment "..."`.

## Scope labels

Cross-repo visibility is handled by scope labels so a single `gh issue list` shows what touches what:

- `scope:bb` — touches bb submodule / tracked in bb repo
- `scope:worker-agent` — worker agent loop on Cloudflare edge
- `scope:infra` — Cloudflare platform / infra

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue on this repo.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R Samuka007/cloudflare-agent-project --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R Samuka007/cloudflare-agent-project --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api repos/Samuka007/cloudflare-agent-project/issues/<map-n>/sub_issues -X POST -F sub_issue_id=<child-db-id>`). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/Samuka007/cloudflare-agent-project/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/Samuka007/cloudflare-agent-project/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> -R Samuka007/cloudflare-agent-project --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> -R Samuka007/cloudflare-agent-project --body "<answer>"`, then `gh issue close <n> -R Samuka007/cloudflare-agent-project`, then append a context pointer (gist + link) to the map's Decisions-so-far.

Every agent-generated issue/PR body ends with the `AGENT GENERATED` line per `AGENTS.md`.
