# Bash-embedding probe: omp brush-core bash inside the daemon client

Spike follow-up to `docs/research/omp-runtime-embedding.md` (T9). The T9 row
there was **reasoning, not a probe** — this document closes that evidence gap by
actually running omp's `BashTool` through the embedded runtime harness
(`Settings.loadIsolated` + minimal `ToolSession`) and measuring the M0 contract
surface, case by case.

- Date: 2026-10-04
- Runtime: bun 1.3.14, omp @ `/home/nixos/workspace/oh-my-pi` (pi-natives `Shell`)
- Harness: `/tmp/omp-bash-probe/{probe,followup,procmodel}.ts` (spike pattern
  from `docs/research/spike/omp-runtime/harness.ts:80-91`)
- Our M0 side: `packages/agent-do/src/tools/registry.ts` (schema) +
  `packages/daemon-service/src/client/executor.ts` (execution) +
  `packages/daemon-service/src/constants.ts` (policy constants)

## Verdict: (b) embed-with-shims

The embedded brush shell **runs headless inside a plain Bun process** and
preserves or supersedes nearly every M0 semantic. T9 does not collapse to a
pure activation ticket: four shims are required, and exactly **one M0 semantic
cannot be honored at all** — the daemon-side, pid-based kill-list across client
restarts (§8.5/I22). Total shim cost ≈ 100–150 LoC around the tool call.

The one-line decisive evidence for the exception:

```
probe "process-model":  echo pid=$$; readlink /proc/$$/exe
→ pid=1352405, /proc/1352405/exe = /nix/store/…-bun-1.3.14/bin/bun
```

**The "shell" is the host process itself.** M0's kill-list
(`executor.ts:108-133`, `verifyAndKill`) records the spawned `bash` child's
pid + `/proc` start time and SIGKILLs the group; with brush embedded there is
no child-shell pid to record — the pid is the daemon client's own. After a
client crash, M0 rebuilds the process table by marker scan
(`executor.ts:scanMarkerProcesses`) and can still verify-and-kill an orphaned
execution; an embedded run leaves no killable handle behind — kill is an
in-process `AbortSignal`, and an aborted client process already took its
same-group externals with it (probe `bg-plain`: plain `&` children are reaped
at run end; only `setsid`-detached ones escape, in both engines).

## Probe results (raw)

| #   | case                   | command                                                 | result (evidence line)                                                                                                                                                                                               |
| --- | ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | pipeline               | `printf 'Hello World' \| tr 'a-z' 'A-Z'`                | `HELLO WORLD`, 58ms, `isError=false`                                                                                                                                                                                 |
| 2   | chain                  | `mkdir -p out && echo x > out/f.txt && cat out/f.txt`   | `x`, 17ms                                                                                                                                                                                                            |
| 3   | stderr-merge           | `echo out-stream; echo err-stream 1>&2`                 | `out-stream\nerr-stream` — one merged stream in arrival order                                                                                                                                                        |
| 4   | exit-code-7            | `echo before-exit; exit 7`                              | `isError=true`, `details.exitCode=7`, notice `Command exited with code 7`                                                                                                                                            |
| 5   | cwd-param              | `pwd` with `cwd: "sub"`                                 | `/tmp/omp-bash-probe/fixture/sub`                                                                                                                                                                                    |
| 6   | persist-set/get        | `PROBE_STATE_VAR=41` then `echo state=$PROBE_STATE_VAR` | `state=41` — **persistent shell session** across calls                                                                                                                                                               |
| 7   | env-inherit            | `echo env=$OMP_PROBE_VAR` (set on `process.env`)        | `env=from-daemon-env`                                                                                                                                                                                                |
| 8   | timeout-clamp-high     | `timeout: 99999`                                        | notice: `Timeout clamped to 3600s (requested 99999s; allowed range 1-3600s)`                                                                                                                                         |
| 9   | timeout-zero-disabled  | `timeout: 0`, `sleep 1`                                 | completed at 1.00s, `details.timeoutDisabled` — deadline-off contract works                                                                                                                                          |
| 10  | timeout-enforced       | `sleep 30`, `timeout: 2`                                | `timedOut=true` at 2.23s, `isError=true`, `[Command timed out after 2 seconds]`                                                                                                                                      |
| 11  | abort-inflight         | `sleep 777`, abort at 1s                                | throws `ToolAbortError: [Command cancelled]`; post: `pgrep -f 'sleep 777'` → `DEAD-777` — **abort kills in-flight externals**                                                                                        |
| 12  | orphan-background      | `nohup sleep 888 &` then run completes                  | post: `DEAD-888` — brush reaps same-group background children at run end                                                                                                                                             |
| 12b | bg-setsid              | `setsid sleep 919 &`                                    | post: `ALIVE-919` (pid 1349753) — setsid escapes the reaping                                                                                                                                                         |
| 12c | bg-nohup-setsid        | `nohup setsid sleep 923 &`                              | post: `ALIVE-923` — maximal detachment survives                                                                                                                                                                      |
| 13  | timeout-bg-child       | `sleep 999 & wait $BG`, `timeout: 2`                    | `timedOut=true` at 2.23s; post: `DEAD-999` — **timeout kills the run's background children** (M0 process-group-kill outcome reproduced)                                                                              |
| 14  | big-output             | `head -c 200000 /dev/zero \| tr '\0' 'x'` (200 KB)      | middle-truncation to `outputBytes: 51224` (~50 KiB cap), `meta.truncation.elidedBytes=148800`, **no `artifactId`, no `artifactError`** — with no `session.allocateOutputArtifact` the elided bytes are silently gone |
| 15  | pty-no-ui              | `pty: true`, `hasUI: false`                             | **not an error**: notice `pty requested but unavailable in this environment; ran without a terminal`                                                                                                                 |
| 16  | process-model          | `echo pid=$$; readlink /proc/$$/exe`                    | `/nix/store/…-bun-1.3.14/bin/bun` — shell is in-process, `$$` = host pid                                                                                                                                             |
| 17  | bang-var (brush quirk) | `sleep 0.05 & echo bang=$!; wait`                       | `wait` (no args) **hangs forever** in brush on an already-finished job — runner had to be killed at 120s                                                                                                             |

## Delta table: M0 semantics vs omp embedded brush

| M0 semantic (source)                                                                                                                                                                     | omp embedded behavior (evidence)                                                                                                                                        | Delta verdict                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process model: `spawn("bash", ["-c", cmd], {detached: true})`, own process group (`executor.ts:53-63`)                                                                                   | Brush-core compiled into pi-natives, runs **inside the host process** (`/proc/$$/exe` = bun); externals spawned as children of the host                                 | **Changed** — no child shell; process tree is `client → externals`                                                                                                                                                                           |
| Kill: service forwards `exec.kill`; client verifies `/proc` start time (pid-reuse guard, §8.5/I22) then `TERM → 5s → KILL` the group (`executor.ts:108-153`, `KILL_ESCALATION_MS=5_000`) | Caller-held `AbortSignal` → `Shell.abort()` (native); in-flight externals die (`DEAD-777`); native timeout enforcement + JS backstop (`bash-executor.ts:649-668`)       | **Changed** — kill = abort, in-process; **cross-restart kill-list impossible** (no pid to record; see verdict). In-flight + same-group cleanup is _equivalent or better_                                                                     |
| Timeout clamp 1–600 s, default 600 s (`registry.ts:55-56`, `DEFAULT_EXEC_TIMEOUT_MS=600_000`)                                                                                            | Clamp 1–3600 s, default 300 s (`tool-timeouts.ts:11`, probe #8)                                                                                                         | **Shim**: settings `tools.maxTimeout=600` restores the 600 s ceiling (`tools/settings.ts:836-839`); map dispatch `timeoutMs` → `timeout` param explicitly to control the default                                                             |
| `timeout: 0` disables deadline                                                                                                                                                           | Same contract, `details.timeoutDisabled` (probe #9)                                                                                                                     | Preserved                                                                                                                                                                                                                                    |
| cwd clamped into sandboxRoot, escape refused (`executor.ts:36-43`)                                                                                                                       | `resolveToCwd(cwd, session.cwd)` + existence stat, **no root concept** (`bash.ts:1009-1046`)                                                                            | **Shim**: wrapper validates resolved cwd under sandbox root before `execute()`; fix `session.cwd` = root. (Note: M0's own docstring concedes bash could address absolute paths outside — confinement was cwd-level, not a security boundary) |
| pty option in schema; M0 executor has no pty path (silent ignore)                                                                                                                        | Degrades with explicit notice (probe #15); interactive pty requires UI (`canUseInteractiveBashPty`)                                                                     | Parity-in-practice; omp is more honest (notice vs silence)                                                                                                                                                                                   |
| Merged stdout/stderr in arrival order (`executor.ts:81-88`)                                                                                                                              | Single merged stream (`out-stream\nerr-stream`, probe #3)                                                                                                               | Preserved                                                                                                                                                                                                                                    |
| Exit code propagated in result                                                                                                                                                           | `details.exitCode` + `isError` + notice (probe #4)                                                                                                                      | Preserved (different transport shape)                                                                                                                                                                                                        |
| Fresh `bash -c` per execution — no cross-call state                                                                                                                                      | Persistent `Shell` per sessionKey; variables survive across calls (probe #6)                                                                                            | **Superset** — omp-verbatim; pin one sessionKey per machine/thread to keep isolation intentional                                                                                                                                             |
| env inherited from daemon process                                                                                                                                                        | `process.env` visible in commands (probe #7)                                                                                                                            | Preserved                                                                                                                                                                                                                                    |
| Inline limit + truncation flag; full output lives in the journal/service buffers, replayable                                                                                             | `OutputSink` 50 KiB inline middle-truncation; full spill **only if** `session.allocateOutputArtifact` provided; without it, `elidedBytes` are silently lost (probe #14) | **Shim**: provide `allocateOutputArtifact` wired to our journal/execution buffers — then omp's artifact footer (`artifact://<id>`) supersedes M0's flag                                                                                      |
| Background children of a run survive normal completion (group untouched on success)                                                                                                      | Brush reaps same-group children at run end (`DEAD-888`); `setsid` children survive (`ALIVE-919/923`)                                                                    | **Changed** — daemonized patterns need `setsid`; same-group stragglers are cleaned eagerly (arguably safer; M0 would leave them until timeout/kill)                                                                                          |
| Watchdog: service alarm re-asks spawn idempotently, forwards `exec.kill` at deadline (`service-do.ts:949-996`)                                                                           | Protocol-level; unaffected by embedding (dispatch frames unchanged — non-goal here)                                                                                     | Unchanged; enforcement point moves into the client process                                                                                                                                                                                   |

Brush quirks observed (do not block, but note for pattern parity): `wait`
without arguments hangs on an already-finished job (probe #17 — runner killed
at 120 s); `$!` was empty in `sleep 999 & BG=$!` (probe #13 printed `bg=`).
Avoid bare `wait`/`$!`-dependent patterns in embedded sessions.

## Shims (≈100–150 LoC in the daemon client executor)

1. **Settings**: `loadIsolated` + override `tools.maxTimeout = 600`; construct
   once per machine session.
2. **cwd guard**: resolve requested cwd against sandbox root, refuse escapes,
   pass absolute path (≈15 LoC).
3. **Artifact allocator**: implement `session.allocateOutputArtifact` against
   the execution buffer/journal so 50 KiB-truncated output is recoverable via
   the `artifact://<id>` footer (≈40–60 LoC).
4. **Kill mapping**: drop the pid kill-list for embedded runs; kill = abort the
   run's `AbortController` (held by our executor wrapper) on `exec.kill` /
   watchdog expiry. Document the cross-restart gap: an orphaned embedded run's
   only same-group stragglers die with the client process; `setsid` escapees
   are the operator's business, same as M0 post-restart today minus
   verify-and-kill (≈20 LoC + docs).

## What would change the verdict

- If daemon-side **orphan kill after client restart** is a hard M0 acceptance
  criterion (not just the §8.5 journal entry): verdict flips to exception
  confirmed for that row only — there is no pid handle to record, so no
  verify-and-kill can exist. Everything else still embeds.
- If `tools.maxTimeout` settings override proves unavailable in
  `loadIsolated` (not probed): add the clamp in our wrapper (≈5 LoC), verdict
  unchanged.
