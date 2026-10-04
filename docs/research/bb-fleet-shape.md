# bb child-thread × fleet shape map

Research for #77 (precursor to grilling #74). Truth source: bb submodule pinned
`ba4265453` (desktop-nightly-2-gba4265453). All `path:line` citations are
relative to `bb/` at that pin; upstream drift moves lines, structural claims
are the payload.

One-line summary: bb has **one `threads` table** with two independent
self-links — `parentThreadId` (hierarchy _ownership_) and `sourceThreadId`
(conversation _provenance_, only ever paired with `originKind: "fork"`) — and a
fleet shape where execution always binds through `thread.environmentId →
environment.hostId`, never through the thread graph.

---

## 1. Storage shape: the two link columns

`packages/db/src/schema.ts` — `threads` table:

- `parentThreadId` (`parent_thread_id`, self-FK, `ON DELETE SET NULL`) —
  schema.ts:565-568. Indexed by `threads_parent_idx` (schema.ts:611).
- `sourceThreadId` (`source_thread_id`, self-FK, `ON DELETE SET NULL`) —
  schema.ts:569-572. Indexed **jointly with originKind**:
  `threads_source_origin_idx on (sourceThreadId, originKind)` (schema.ts:612-616).
- `originKind` — schema.ts:573-576; domain enum has exactly one value:
  `threadOriginKindValues = ["fork"]` (`packages/domain/src/thread-origin-kind.ts:12-13`,
  "0084 moved every legacy row over"). "Side chat" is **not** an originKind —
  it is `fork` + `originPluginId` + `visibility: "hidden"`.
- `originPluginId` — schema.ts:577-580: "Id of the plugin that spawned this
  thread (create origin `plugin`). NULL for every other origin." Indexed for
  the side-chat sweep (`threads_origin_plugin_archived_idx`, schema.ts:617-620,
  comment: "The side-chat plugin's hourly sweep pages through its own live forks").
- `visibility` — schema.ts:581-584; `["visible","hidden"]`
  (`packages/domain/src/thread-visibility.ts:3`).

Semantics divergence, confirmed at the UI layer: a hierarchy child renders as a
**child** pill keyed off `parentThreadId !== null`
(`apps/app/src/components/settings/ArchivedThreadsSettingsSection.tsx:152-153,269-272`),
a fork links back via `sourceThreadId` + `originKind: "fork"`
(`apps/app/src/components/secondary-panel/ThreadMetadataContent.tsx:259-267`),
and thread-type pills are "child/fork/side chat"
(`apps/app/src/components/ui/pill.stories.tsx:16-17`).

## 2. Create-route semantics: the two columns are an XOR

`apps/server/src/routes/threads/base.ts`:

- `post(routes.create)` → `createThreadFromRequest` (base.ts:301-310).
- `post(routes.fork)` → `createThreadForkFromRequest` (base.ts:312-315).
- `get(routes.childSummary)` → assigned-child count (base.ts:336-339;
  count at base.ts:328-331 via `countNonDeletedAssignedChildThreads`).

Core resolution in `apps/server/src/services/threads/thread-create.ts:641-687`:

```
originKind             = requestInput.originKind ?? null            // :641
sourceThreadId         = requestInput.sourceThreadId
  ?? (originKind !== null ? requestInput.parentThreadId : undefined) // :642-644
hierarchyParentThreadId= originKind === null ? requestInput.parentThreadId : undefined // :645-646
```

Rules enforced server-side:

1. `sourceThreadId` without `originKind` → 400 "sourceThreadId requires an
   originKind" (thread-create.ts:653-659). Same for `sourceSeqEnd` (:660-666).
2. `originKind` without a resolvable source → 400 "originKind requires a
   sourceThreadId" (:681-687). Request-level `parentThreadId` on a fork is
   **reinterpreted as** sourceThreadId (:642-644).
3. Source must be live and same-project: `requireLiveSourceThread` —
   not-found / cross-project / archived / deleted each 400
   (thread-create.ts:332-361).
4. **Forks are not hierarchy children**: for a fork, `parentThreadId` stays
   NULL; only `sourceThreadId` is written. But a fork still consumes the
   source's spawn allowance ("Forks and side chats are not hierarchy children,
   but they still consume the same spawn allowance exposed as
   `ThreadResponse.canSpawnChild`", thread-create.ts:673-680; allowance =
   hierarchy depth below `MAX_THREAD_HIERARCHY_DEPTH = 4`,
   `apps/server/src/services/threads/thread-parent.ts:6,141-149`).
5. Parent validation (`assertValidParentThread`, thread-parent.ts:151-185):
   exists, same project, unarchived, undeleted, and
   `parentDepth + childSubtreeDepth ≤ 4` ("too_deep" :180-182).
6. Anti-forgery on agent-seeded starts: `startedOnBehalfOf` requires a
   source/parent anchor, `senderThreadId` must equal that anchor, and it
   requires `originKind` so seeded forks can't reshape project execution
   defaults (thread-create.ts:697-729). Idle side-chat forks use exactly this:
   seed-only fork ⇒ `startedOnBehalfOf: { initiator: "agent",
senderThreadId: sourceThread.id }` (thread-fork.ts:140-144).
7. Visibility default: explicit request wins; else a hierarchy child inherits
   its parent; else visible ("A side chat is forked with an explicit `hidden`
   by the plugin that owns it" — thread-create.ts:553-567, impl :581-586).
8. Row write: `createThreadRecord` persists the resolved columns
   (thread-create-helpers.ts:167-203, columns at :178-183).
9. Re-parenting after create: PATCH update accepts `parentThreadId`
   (base.ts:341-348 validation, :377-379 write), emits ownership
   assigned/removed system messages to old+new parents
   (`thread-ownership.ts:112-157`) and releases children when a parent
   archives (set `parentThreadId = null` per child,
   `thread-ownership.ts:161-182`).

### 3. The four "child" shapes (taxonomy)

| shape                             | parentThreadId     | sourceThreadId | originKind | visibility                                         | lives on                                                           | owner                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------ | -------------- | ---------- | -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy child ("worker thread") | parent id          | NULL           | NULL       | inherit parent (thread-create.ts:581-586)          | parent's host by default (§7)                                      | parent owns/reporting (§5)                                                                                                                                                                                                                         |
| visible fork                      | NULL               | source id      | `fork`     | requested (default visible; sdk default `visible`) | source's host, reuse or sibling worktree (thread-fork.ts:64-94)    | standalone thread                                                                                                                                                                                                                                  |
| side chat                         | NULL               | source id      | `fork`     | `hidden` (explicit)                                | source thread's _environment_ (reuse, side-chat/server.ts:200-207) | side-chat plugin (`originPluginId: "side-chat"`)                                                                                                                                                                                                   |
| in-thread delegation              | n/a — not a thread | n/a            | n/a        | n/a                                                | same thread                                                        | provider subagent; timeline renders a `delegation` work row with nested `childRows` (`packages/thread-view/src/build-thread-timeline.ts:686-706`; link state `delegationParentToolCallIdsByProviderThreadId`, `build-event-projection.ts:823-828`) |

Rows 1-3 are rows in `threads`; row 4 never touches the table — keep these
apart when porting.

## 4. Side-chat lifecycle (`plugins/side-chat/`)

Contract header: "Side chats are plain hidden thread forks
(`originKind: "fork"`, `originPluginId: "side-chat"`, `visibility: "hidden"`)
created idle at panel-open time" (plugins/side-chat/server.ts:1-5).

1. **Open**: frontend message action / launcher → single-flight guard so a
   double click can't mint two forks (`inFlightOpens`,
   plugins/side-chat/app.tsx:119-152) → POST plugin rpc `createSideChat`
   (app.tsx:154-175).
2. **Create (server)**: `createSideChat` (server.ts:178-225) reads the source
   timeline, computes the reply-anchor seed server-side (`resolveReplySeedText`,
   seed prefix "Replying to this earlier message in the conversation:\n\n",
   server.ts:13-14), then `bb.sdk.threads.fork` with `visibility: "hidden"`,
   `workspace: "reuse"` (comment: an aside about the source's work runs in the
   source's environment; `isolated` would copy files that drift, server.ts:200-207)
   and optional `agentContextSeed` (agent-only). Anchors older than the first
   provider session fall back to tip-fork (server.ts:209-221).
3. **Panel**: a thread-panel tab with persisted params
   `{ threadId, sourceThreadId, sourceMessageText, sourceSeqEnd }`
   (app.tsx:29-56, params parse :58-88); host-side scope key
   `side-chat/<projectId>/<parentThreadId>/<tabId>/<childThreadId ?? "draft">`
   (`apps/app/src/components/plugin/plugin-composer-host.tsx:37-38`).
4. **Retire, path A (structural cascade)**: archiving the source thread
   archives its live hidden source-forks — "A hidden fork (a side chat, say)
   has no row of its own to reach, so it must not outlive its source.
   Structural rather than plugin-owned"
   (`apps/server/src/services/threads/thread-archive.ts:75-95`, query :89-92);
   `archiveThreadAndChildren` cascades assigned children **and** hidden source
   forks together (thread-archive.ts:132-160).
5. **Retire, path B (plugin sweep)**: hourly cron `13 * * * *`
   (server.ts:242) pages its own live hidden forks via the
   `originPluginId` index (§1), archives empty forks older than 24h
   (`EMPTY_FORK_MAX_AGE_MS`, server.ts:17); a fork with any user message or
   pending queued message is "kept" and permanently remembered in KV
   (`kept-fork:` prefix, server.ts:27, verdict set server.ts:269-272); failed
   reads skip (fail closed, server.ts:304-349).

## 5. sendToMain and child→parent reporting

**sendToMain** (side-chat only):

- Contract: `sendToMain({ sourceThreadId, senderThreadId, text })`
  (server.ts:163-173).
- Client: per-assistant-message action "Send to main thread"
  (app.tsx:282-289, rpc call :253-263).
- Server impl: `bb.sdk.threads.queuedMessages.create({ threadId:
sourceThreadId, input, senderThreadId })` — the **fork's text is queued on
  the source thread** with the fork as sender (server.ts:227-236).
- Persistence: `queued_thread_messages.senderThreadId`
  (`packages/db/src/schema.ts:842-843`); same route used by thread sends
  (`apps/server/src/routes/threads/actions.ts:260-286`).
- Rendering: agent-initiated rows with a sender render as generated
  "Message from \<thread\>" rows; `sourceThreadId` drives the link
  (`apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx:62-70,284-291`),
  and a plugin-side-chat sender opens the plugin panel instead of the thread
  route (`GeneratedConversationMessage.tsx:68-70,285-286`;
  `ConversationMessageContent.tsx:409-434`;
  `ThreadTimelineRows.tsx:993-999,1050-1053`).

**Hierarchy-child reporting** (separate, automatic): a child's terminal turns
are batched per parent (2 s window,
`apps/server/src/services/threads/child-thread-notifications.ts:77`) into a
parent system message with child mentions, terminal-output excerpt, and
interrupted/workflow guidance (:80-102, queue/flush :413-490); blocked children
queue a needs-attention notification after the response
(`apps/server/src/internal/interactive-requests.ts:91-108`); archived parents
are skipped (`parent-system-messages.ts:413-429`). Hidden children keep
reporting — "a hidden child still reports its turns and blockers to its parent"
(builtin skill text, `apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md:490-493`).

## 6. Hub delegation semantics → ruled DO mapping

bb splits control plane (server) from execution (host daemons):

- Enrollment: `hosts` table with `lastSeenAt`
  (`packages/db/src/schema.ts:88-106`); installer/enrollment story in
  `bb/docs/multiple-devices.md` ("Add an execution machine", one daemon data
  dir per server `~/.bb-machines/<server-host>`).
- The hub keeps `hostId ↔ daemon session socket`: `registerDaemon` replaces
  any prior session for a host (`apps/server/src/ws/hub.ts:456-475`), wires at
  WS open (`apps/server/src/ws/daemon-protocol.ts:91`), unwinds on close
  (`apps/server/src/internal/session-owner-side-effects.ts:138-139`), with a
  5 s disconnect grace (`apps/server/src/constants.ts:4`).
- server→daemon delegation = `host-rpc.request/response` with requestId:
  `requestHostOnlineRpc` parks a waiter keyed by requestId and rejects on
  timeout (`hub.ts:636-668`); wait-for-registration helper
  `waitForDaemonForHost` (`hub.ts:513-528`). Two command transports:
  `callHostOnlineRpc` (30 s default `COMMAND_TIMEOUT_MS`,
  `apps/server/src/constants.ts:1`; retryable variant
  `apps/server/src/services/hosts/online-rpc.ts:36-58`) and settled long
  commands at `LIVE_DAEMON_COMMAND_TIMEOUT_MS = 24h`
  (`apps/server/src/services/hosts/live-command.ts:21`).
- Thread creation touches the hub before any row: `ensureCreateHostOnline`
  (thread-create.ts:782-784) — create fails if the target host's daemon is
  offline.

**The ruled mapping** (already decided in this repo, restated so #74 grills
against it): `docs/research/bb-daemon-protocol.md` §7 — GatewayDO **one per
machine**, corresponding to bb's `hostId ↔ socket` map (hub.ts:636-668); HTTP
session-open → WS attach; `host-rpc.request/response` + requestId + explicit
timeout (DO `alarm()` as the watchdog equivalent of hub waiters); daemon→server
events via batched POST + server-owned sequence + per-event ack; disconnect =
grace window + session invalidation + re-open reconciliation. Explicitly _not_
ported: TunnelDO's binary frame protocol (that channel is a reverse-relay data
plane, not a low-fanout control plane).

## 7. Fleet: child-thread ownership across machines

Ownership is **physical** (environment/host), never derived from the thread
graph:

- Chain: `threads.environmentId` → `environments.hostId` (NOT NULL FK to
  `hosts`, `packages/db/src/schema.ts:491-494`; per-project unique
  `(projectId, hostId, path)`, schema.ts:523-528). A thread with
  `environmentId = null` is machineless ("plain chats",
  `apps/app/src/components/sidebar/machineThreadGroups.ts:7`).
- **Hierarchy child default**: with a live parent and an implicit host default
  request → personal project reuses the parent's environment; any other
  project provisions a fresh managed worktree **on the parent's host**
  (`resolveCreateThreadEnvironment`,
  `apps/server/src/services/threads/thread-default-policy.ts:266-303`). So a
  delegated worker stays co-located with its parent unless explicitly sent
  elsewhere.
- **Fork/side chat**: `resolveForkEnvironment` keeps the source's `hostId` in
  every branch — `reuse` the same environment, or a sibling managed worktree /
  personal workspace on the same host (`apps/server/src/services/threads/thread-fork.ts:64-94`);
  the fork route's `forkSourceEnvironmentId` guard prevents the generic child
  default from flipping an isolated personal fork back to source reuse
  (thread-create.ts:688-696, 759-769). Forks never cross hosts.
- **Explicit cross-machine spawn** is a caller choice, validated:
  `bb thread spawn --machine <id-or-name>` (alias `--host`) resolves the name
  to a hostId (`apps/cli/src/commands/thread/spawn.ts:183-188,253-258`);
  `--machine` cannot be combined with an existing environment ID ("that
  environment already selects its machine", spawn.ts:236-244). Other relevant
  flags: `--parent-thread <id>` / `--parent-self` (:188-189),
  `--visibility` documented "a child inherits its parent" (:218-221),
  `--origin-kind fork --source-thread <id>` (:222-224). Spawned-child
  notification hook: "You will be notified when this thread is done."
  (spawn.ts:334-339).
- **Projection**: the sidebar "By machine" view buckets threads by
  `thread.environmentHostId` in server host order, stale hosts keep an
  id-ordered section, machineless threads land in a trailing "No machine"
  group (`machineThreadGroups.ts:24-57`); sidebar parent rows pin their child
  chains up to depth 4 (`apps/app/src/components/sidebar/ProjectRow.stories.tsx:273-282`;
  ancestor walk `ProjectList.tsx:1830-1838`).
- **Lifecycle coupling on ownership change/archive**: re-parenting emits
  ownership system messages to both parents (thread-ownership.ts:112-157);
  archiving a parent releases assigned children (parentThreadId → NULL,
  thread-ownership.ts:161-182) and archives hidden source forks structurally
  (§4 path A). Deletion/archive confirmation is gated on live assigned-child
  count (`child-thread-confirmation.ts:32-36`, base.ts:424-427).
- Note the plugins' own statement of the contract: a thread spawned with
  `parentThreadId` inherits visibility and attribution via
  `origin: "plugin"` + `originPluginId` (SKILL.md:490-493, 1462-1465) —
  "an organization contract, not a security boundary: plugins are full-trust
  server code" (SKILL.md:493-494).

## 8. Carry-forward invariants for #74 (grilling inputs)

1. `parentThreadId` and `sourceThreadId` are **orthogonal axes**
   (ownership vs provenance); a port that merges them into one "parent" field
   loses the fork/side-chat shape and the (sourceThreadId, originKind)
   listing axis.
2. `originKind` is currently a single-valued enum (`fork`) with
   plugin attribution carried by `originPluginId` + `visibility` — a new child
   kind means widening the enum, not overloading parentThreadId.
3. Forks/side chats are _not_ hierarchy nodes yet still consume the spawn
   allowance — depth-cap accounting counts them even though they don't nest.
4. Physical placement rides `environmentId → hostId`; every default path
   (child inherit, fork reuse/sibling worktree, side-chat reuse) is
   **same-host by construction**; cross-host is an explicit caller act.
   GatewayDO-per-machine therefore never needs thread-graph awareness, and a
   child's DO is determined at create time by environment resolution.
5. Lifecycle cascades are two-track: structural (archive source ⇒ hidden
   forks retire; archive parent ⇒ children released, not deleted) and
   plugin-owned (side-chat hourly empty-fork sweep + KV kept-verdict).
6. sendToMain is **message transport, not control flow**: fork output becomes
   a queued message on the source with `senderThreadId` attribution; the
   parent-side delegation reporting (batched turn system messages,
   needs-attention) is a distinct channel that also serves hidden children.
