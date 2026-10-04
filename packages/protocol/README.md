# @cap/protocol

The single frozen contract for the cloudflare-agent-project walking skeleton
(ticket #18). The bb SPA (UX line) and every future server/client package
import from here — no hand-copied schemas.

Everything below was decided by archaeology of the bb repo (fork of
`get-bb/bb`, read-only): `apps/app` (SPA consumption), `packages/server-contract`,
`packages/domain`, `packages/host-daemon-contract`.

> Scope ruling (2026-10-03, mid-ticket): the machine-side topology was
> re-adjudicated (bb server worker + daemon service layer + thin host client).
> The SPA-facing face frozen here is topology-independent and stays frozen as
> shipped; the machine-side WS contract and the fake ends are **deferred** to
> the follow-up ruling and live only in the working tree until then.

## 1. bb SPA API face — archaeology conclusions

Transport: the SPA calls the server through a typed client over
`packages/server-contract/src/public-api.ts`, mounted at **`/api/v1`**
(public-api.ts:1505), plus two WebSockets and zero SSE/EventSource.

Full consumed REST face (~180 routes, grouped; evidence: scout inventory over
`apps/app/src/hooks/queries|mutations`, `lib/sdk.ts`, `lib/api.ts` against
`public-api.ts`):

| Group                                                                                          | Routes                                                                                       | Frozen here (M0 face)                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| projects + sidebar                                                                             | ~25 (GET/POST /projects, /sidebar-bootstrap, sources, files, skills, branches, attachments…) | `GET /sidebar-bootstrap` (minimal shape)             |
| files / previews                                                                               | 9                                                                                            | — (host-file face, deferred)                         |
| hosts                                                                                          | 12 (join-codes, provider-clis…)                                                              | — (machine-side, deferred)                           |
| terminals                                                                                      | 8 + terminal WS                                                                              | — (deferred)                                         |
| environments                                                                                   | 12 (diff/actions/PR…)                                                                        | — (deferred)                                         |
| thread sections                                                                                | 3                                                                                            | —                                                    |
| **threads**                                                                                    | ~40                                                                                          | **create/get/delete/list/send/stop/events/timeline** |
| queued messages, interactions, pins, tabs, read-state, edit-message, fork, rate-limit-recovery | ~20                                                                                          | — (additive growth)                                  |
| system / settings                                                                              | ~20                                                                                          | `GET /system/version`                                |
| plugins / marketplaces / skills-registry (sdk hand-written paths)                              | ~25                                                                                          | —                                                    |

M0 relevance rule (spec #17 UX line): thread 列表、对话、流式渲染. The threads
group + version + sidebar bootstrap is exactly that face; everything else is
recorded above and grows additively without reshaping what is frozen.

### Streaming model (decision)

The bb SPA does **not** consume a payload event stream. It uses:

1. one reconnecting WebSocket to `/ws` carrying _change notifications only_
   (`apps/app/src/lib/ws.ts:36`), consumed leniently and mapped to TanStack
   Query invalidations (`hooks/realtime-cache-effects.ts`);
2. HTTP refetch of `GET /threads/:id/events?afterSeq=N` (long-poll variant
   `/events/wait` exists) for actual data.

We freeze that split: **WS = invalidation hints, HTTP = idempotent replay**.
This is what makes crash recovery testable and keeps `(threadId, seq)` the
single ordering authority.

## 2. Frozen HTTP surface (`/api/v1`)

`src/http.ts` (`HTTP_ROUTES` is the normative list):

- `GET /system/version` → `{version, protocol:{http,realtimeWs}}`
- `GET /sidebar-bootstrap` → `{projects:[{id,name}], threads:[ThreadSummary]}`
- `GET|POST /threads`, `GET|DELETE /threads/:id`
- `POST /threads/:id/send` `{input:[{type:"text",text}],mode?,clientRequestId?}` → `{ok:true}`
- `POST /threads/:id/stop` → `{ok:true}`
- `GET /threads/:id/events?afterSeq=&limit=` → `{events:[envelope],latestSeq,hasMore}`
- `GET /threads/:id/timeline` → `{rows:[TimelineRow],latestSeq}`

Shapes follow bb naming (`ThreadSummary.status` uses bb's
`idle|starting|active|stopping|error`; timeline rows keep bb's
`sourceSeqStart/sourceSeqEnd`, `kind: conversation|work|system`).

**Deviations from bb (all additive-safe):** `projectId` optional on create
(bb requires it; servers may default `"default"`); `input` optional on create;
`origin`/provider-selection fields deferred; events query uses numeric
coercion instead of bb's string-regex; the timeline is a single flat page
(bb has segment paging `includeNestedRows/segmentLimit` — reintroduce when the
SPA integration ticket needs it).

## 3. Event log schema + seq/idempotence semantics

`src/events.ts`. Envelope is bb's `ThreadEventRow` shape: `{id, threadId, seq,
type, data, createdAt}` with per-type `data` schemas (bb separates transport
envelope from payload exactly like this).

Frozen event types (bb namespace convention `client/ | turn/ | item/ |
system/`; growth is additive):

- `client/thread/start`, `client/turn/requested` (carries `clientRequestId`)
- `turn/started`, `turn/completed` (`status: completed|failed|interrupted`, `error{category,message}|null`)
- `item/started`, `item/completed` (items: `userMessage|agentMessage|commandExecution|toolCall`)
- `item/agentMessage/delta` (streaming text)
- `system/error` (`category: machine_disconnected|internal|cancelled`)

Semantics (spec #17 turn-safety model):

- `seq` is **server-owned**, 1-based, contiguous per thread, never reused;
  `(threadId, seq)` is the unique primary key (`eventRowId`).
- Producers other than the server must never supply `seq` (bb enforces the
  same on its daemon wire schema — session.ts:199 "Daemon events must not
  provide a server-owned sequence").
- Replay is idempotent: `GET events?afterSeq=N` returns the ascending suffix
  `> N` always, from the append-only log (no compaction in M0).
- Sends are idempotent on `clientRequestId`: a retried send whose request id
  was already appended starts no new turn.
- Events are appended **before** external side effects (broadcasts, tool
  dispatch); turn state is a pure function of the log.
- WS reconnect never loses data: clients replay from their last seen `seq`
  (`changed.metadata.latestSeq` is a hint, not a promise).

## 4. Realtime WS (`/ws`) — `src/realtime-ws.ts`

bb-shaped: client sends ref-counted `{type:"subscribe"|"unsubscribe", target}`;
server pushes `{type:"changed", entity:"thread", id, changes[...],
metadata?{latestSeq}}`, plus `subscribed`/`unsubscribed` acks (additive; the
bb SPA ignores unknown frames). M0 change kinds: `thread-created`,
`thread-deleted`, `events-appended`, `status-changed`, `title-changed`
(bb has 16; additive). Malformed client frames are ignored (the SPA parses
leniently too); the socket carries no payloads.

## 5. Error classification — `src/errors.ts`

HTTP envelope is bb's `{code, message, details?, retryable?}`
(server-contract/src/errors.ts:11). Closed M0 code set with fixed status +
retryability mapping: `bad_request`(400), `validation_failed`(422),
`not_found`(404), `conflict`(409, details `{reason:"turn-active"}` for a
second send), `machine_unavailable`(503, retryable), `internal`(500,
retryable). bb's richer lifecycle unions (thread_not_writable,
environment_not_ready, …) grow additively on the same envelope.

## 6. Deferred by the topology ruling

The machine-side WS contract (daemon handshake/tool-call shapes drafted after
`packages/host-daemon-contract`), the fake brain/edge and the fake machine end
are **not part of this freeze**. Drafts live in the working tree; they will be
re-grounded once the server/daemon/host-client split is named.
