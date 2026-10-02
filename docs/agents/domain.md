# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.
- **`docs/agents/project-management.md`** — cross-repo tracking rules (bb submodule + GitHub Project).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo today):

```
/
├── CONTEXT.md          (lazy — created when domain-modeling first needs it)
├── docs/adr/           (lazy)
├── bb/                 (git submodule — fork of get-bb/bb)
├── apps/
├── packages/
└── plugins/
```

## Established vocabulary

Terms that already have meaning in this project (use them; don't invent synonyms):

- **Worker agent** — the agent loop running on Cloudflare Workers (workerd), as opposed to a local/CLI agent.
- **Host daemon** — bb's existing host-side process; in this project it is a pure tool executor (fs/pty/workspace), not an agent spawner.
- **Enrolled machine** — a machine running host daemon, connected outbound to the server/edge.
- **bb** — the fork `Samuka007/bb` used as UX / thread / event-model substrate.
- **Loop** — the agentic turn cycle (model call → tool call → result → next model call).
- **Trajectory** — the append-only event log of a thread's agent interactions.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (…) — but worth reopening because…_
