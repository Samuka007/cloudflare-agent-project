# pi-durable DO spike (#580)

Throwaway evidence for wayfinder map #571. Not production code.

## What it proves

1. `Harness.open(await openDurableObjectSqliteStorage(ctx.storage))` runs inside a
   SQLite-backed Durable Object.
2. A turn cut off mid-stream by eviction recovers through a heartbeat alarm.
3. A `replay: "unsafe"` tool that hangs mid-execution is **not** rerun after
   eviction; the model sees an interrupted tool result and the run continues.

Note: published `1.3.0` has no `Harness.wake()`/`onWake` (those are on `main`,
unreleased). The worker arms a 60 s heartbeat alarm and calls `resume()`.
`settings.contextRetentionMs: 0` / `documentRetentionMs: 0` are required on
1.3.0 because its retention timers otherwise pin the object and block eviction
(fixed on `main`).

## Run

This directory is standalone (its own package.json). From here:

```sh
pnpm install
pnpm test
```

The test runs in workerd via `@cloudflare/vitest-plugin`; eviction/alarm are
Cloudflare's own (`cloudflare:test`).

Measured on 2026-10-19: 2 tests passed in ~0.55 s; `wrangler deploy --dry-run`
bundle 1038.88 KiB raw / 188.85 KiB gzip.

## Source attribution

`worker.ts` is adapted from `@earendil-works/pi-durable@1.3.0`
`test-workers/worker.ts` (MIT), with the hanging `marker` tool added.

## Evidence

The ticket #580 comment records the run output, test durations, and bundle
observations. Do not merge this directory as production code.
