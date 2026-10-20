import type { ThreadEventEnvelope } from "@cap/protocol";

/**
 * The pending badge state folded from the journal's interaction rows (#591
 * db campaign T8). `pendingSince` = createdAt of the earliest unresolved
 * interaction (null clears the badge); `foldSeq` = the journal seq of the
 * interaction row this state was folded from.
 */
export interface PendingBadgeState {
  pendingSince: number | null;
  foldSeq: number;
}

/** The DO→control-plane push face. The monotonic CAS lives server-side. */
export interface PendingBadgePush {
  threadId: string;
  pendingSince: number | null;
  foldSeq: number;
}

/**
 * Fold of the journal's interaction lifecycle rows (`interaction.registered`
 * / `.resolved` / `.interrupted` — the ask channel's vocabulary) into the
 * badge state. The fold position rides the push, so a replayed fold after a
 * DO eviction re-derives the identical (pendingSince, foldSeq) pair and the
 * control-plane monotonic CAS turns the re-push into a no-op — a replay
 * never rewrites the threads row.
 *
 * Returns null when the journal holds no interaction rows: nothing has ever
 * flipped, so there is nothing to push.
 */
export function foldPendingBadge(events: readonly ThreadEventEnvelope[]): PendingBadgeState | null {
  let foldSeq = 0;
  const openSince = new Map<string, number>();
  for (const event of events) {
    if (event.type === "interaction.registered") {
      const id = event.data.interactionId;
      if (typeof id === "string") openSince.set(id, event.createdAt);
    } else if (event.type === "interaction.resolved" || event.type === "interaction.interrupted") {
      const id = event.data.interactionId;
      if (typeof id === "string") openSince.delete(id);
    } else {
      continue;
    }
    foldSeq = event.seq;
  }
  if (foldSeq === 0) return null;
  let pendingSince: number | null = null;
  for (const since of openSince.values()) {
    if (pendingSince === null || since < pendingSince) pendingSince = since;
  }
  return { pendingSince, foldSeq };
}
