# Cross-Repo Project Management

How to avoid losing bb-submodule tickets when working in this monorepo.

## Problem

Default `gh issue list` in this repo only shows `Samuka007/cloudflare-agent-project` issues. bb-internal tickets (`Samuka007/bb`) are invisible unless you explicitly query that repo.

## Solution: GitHub Project (cross-repo)

A single GitHub Project (v2) can pull issues from multiple repos into one board/table.

### Setup (one-time)

```bash
# Create a project owned by you
gh project create --owner Samuka007 --title "cloudflare-agent-project" --format json --jq '.url'

# Add both repos as sources
gh project item-add <PROJECT_NUMBER> --owner Samuka007 --url https://github.com/Samuka007/cloudflare-agent-project/issues/1
gh project item-add <PROJECT_NUMBER> --owner Samuka007 --url https://github.com/Samuka007/bb/issues/1
```

Or via the web UI: **Projects → New project → Table → Add repositories** → pick both `Samuka007/cloudflare-agent-project` and `Samuka007/bb`.

### Recommended views

| View             | Filter                                  | Purpose                      |
| ---------------- | --------------------------------------- | ---------------------------- |
| **All open**     | `is:open`                               | Everything across both repos |
| **bb only**      | `repo:Samuka007/bb is:open`             | bb submodule focus           |
| **Worker agent** | `label:scope:worker-agent is:open`      | Cloudflare agent loop only   |
| **Frontier**     | `label:wayfinder:* is:open no:assignee` | Unclaimed wayfinder tickets  |

### Daily driver

Use `gh project item-list <PROJECT_NUMBER> --owner Samuka007` or the web board. The project is the **scope view**; the repos remain the **source of truth** for issue state.

## Repo-local query shortcuts

```bash
# All open issues across both repos (CLI fallback)
gh issue list -R Samuka007/cloudflare-agent-project --state open
gh issue list -R Samuka007/bb --state open

# Cross-repo search
gh search issues --owner Samuka007 "cloudflare agent" --state open
```

## Submodule pointer bumps

When bb work lands on `Samuka007/bb` and you want this repo to pin it:

```bash
cd bb
git fetch origin
git checkout <branch-or-sha>
cd ..
git add bb
git commit -m "chore: bump bb submodule to <sha>"
```
