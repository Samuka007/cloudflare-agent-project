/**
 * Watch-set aggregation → per-host state machine (bb
 * `apps/server/src/ws/watch-interests.ts` @ 8473d8c33, WatchInterestCoordinator
 * + sendSnapshotsForHosts). Ported semantics, preserved exactly:
 *
 * - a candidate generation is `last + 1` (0 before any send);
 * - the emitted frame is `watch-set.replace` carrying
 *   `{generation, workspaceTargets, threadStorageTargets}`;
 * - the fingerprint is `JSON.stringify({workspaceTargets, threadStorageTargets})`;
 * - identical fingerprint ⇒ no emit AND the candidate generation is discarded
 *   (bb :205-214 — generation only advances on actual sends);
 * - `reconcile` (session-open response) resolves the current set at the
 *   current generation without emitting (bb reconcileWatchSetForHost).
 *
 * Divergence from bb (documented): bb stored interests in process memory and
 * folded client subscriptions globally; here one HostOrchestratorDO per host
 * owns its host's slice (port-inventory §5.3), so target→host resolution is
 * the caller's job and targets are pinned to this DO's host at upsert time.
 * Target order is sorted by id for storage-rebuild determinism (bb relied on
 * DB row order).
 */

import type { DaemonWatchSetWire, WatchSetReplaceMessageWire } from "./session-contract.js";

export type DaemonWatchSetWorkspaceTarget = DaemonWatchSetWire["workspaceTargets"][number];
export type DaemonWatchSetThreadStorageTarget = DaemonWatchSetWire["threadStorageTargets"][number];
export type DaemonWatchSet = DaemonWatchSetWire;
export type WatchSetReplaceMessage = WatchSetReplaceMessageWire;

/** One watchable interest after host attribution. */
export type WatchInterest =
  | { kind: "environment-detail"; target: DaemonWatchSetWorkspaceTarget }
  | { kind: "thread-detail"; target: DaemonWatchSetThreadStorageTarget };

export interface WatchSetApplyArgs {
  /** Add or replace interests by key. */
  upserts: { key: string; interest: WatchInterest }[];
  /** Remove interests by key (unknown keys ignored, bb unsubscribe shape). */
  removals: string[];
}

/** bb fingerprint formula (watch-interests.ts:207-209) — exact shape. */
export function watchSetFingerprint(watchSet: DaemonWatchSet): string {
  return JSON.stringify({
    workspaceTargets: watchSet.workspaceTargets,
    threadStorageTargets: watchSet.threadStorageTargets,
  });
}

interface WatchSetSnapshot {
  generation: number;
  fingerprint: string;
  watchSet: DaemonWatchSet;
}

/**
 * Generation+fingerprint state machine. Pure: persistence of `snapshot` and
 * emission are the owner's (the DO persists the snapshot and appends the
 * `watch-set.replace` frame to its daemon outbox).
 */
export class WatchSetAggregator {
  private readonly interests = new Map<string, WatchInterest>();
  private generation = 0;
  private lastSentFingerprint: string | null = null;

  apply(args: WatchSetApplyArgs): void {
    for (const { key, interest } of args.upserts) {
      this.interests.set(key, interest);
    }
    for (const key of args.removals) {
      this.interests.delete(key);
    }
  }

  hasInterest(key: string): boolean {
    return this.interests.has(key);
  }

  interestCount(): number {
    return this.interests.size;
  }

  /**
   * The live interest map as a re-applicable apply() argument — the storage
   * round-trip (DO restart) rebuilds the aggregator from this.
   */
  snapshotInterests(): WatchSetApplyArgs {
    return {
      upserts: [...this.interests.entries()].map(([key, interest]) => ({
        key,
        interest,
      })),
      removals: [],
    };
  }

  /** Resolve the current targets into a watch set at the given generation. */
  resolve(generation: number): DaemonWatchSet {
    const workspaceTargets = new Map<string, DaemonWatchSetWorkspaceTarget>();
    const threadStorageTargets = new Map<string, DaemonWatchSetThreadStorageTarget>();
    for (const interest of this.interests.values()) {
      if (interest.kind === "environment-detail") {
        workspaceTargets.set(interest.target.environmentId, interest.target);
      } else {
        threadStorageTargets.set(interest.target.threadId, interest.target);
      }
    }
    return {
      generation,
      workspaceTargets: [...workspaceTargets.values()].sort((a, b) =>
        a.environmentId.localeCompare(b.environmentId),
      ),
      threadStorageTargets: [...threadStorageTargets.values()].sort((a, b) =>
        a.threadId.localeCompare(b.threadId),
      ),
    };
  }

  /**
   * bb reconcileWatchSetForHost: the session-open response — the set at the
   * current generation, no emit, no generation change.
   */
  reconcile(): DaemonWatchSet {
    return this.resolve(this.generation);
  }

  /**
   * bb sendSnapshotsForHosts: candidate = last+1; identical fingerprint to the
   * last *sent* set skips the emit and keeps the old generation.
   */
  refreshForSend(): WatchSetSnapshot {
    const candidateGeneration = this.generation + 1;
    const watchSet = this.resolve(candidateGeneration);
    const fingerprint = watchSetFingerprint(watchSet);
    if (this.lastSentFingerprint === fingerprint) {
      return {
        generation: this.generation,
        fingerprint,
        watchSet: this.resolve(this.generation),
      };
    }
    this.generation = candidateGeneration;
    this.lastSentFingerprint = fingerprint;
    return { generation: candidateGeneration, fingerprint, watchSet };
  }

  /** Restore persisted state (DO restart / hibernation). */
  restore(snapshot: { generation: number; fingerprint: string | null }): void {
    this.generation = snapshot.generation;
    this.lastSentFingerprint = snapshot.fingerprint;
  }

  currentGeneration(): number {
    return this.generation;
  }

  currentFingerprint(): string | null {
    return this.lastSentFingerprint;
  }
}
