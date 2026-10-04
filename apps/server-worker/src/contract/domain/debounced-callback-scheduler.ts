//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
export interface DebouncedCallbackSchedulerArgs {
  debounceMs: number;
  maxWaitMs: number;
  onFlush: () => void;
}

export interface DebouncedCallbackScheduler {
  dispose: () => void;
  flush: () => void;
  schedule: () => void;
}

export function createDebouncedCallbackScheduler(
  args: DebouncedCallbackSchedulerArgs,
): DebouncedCallbackScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function flush(): void {
    clearTimers();
    args.onFlush();
  }

  function schedule(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flush, args.debounceMs);
    maxWaitTimer ??= setTimeout(flush, args.maxWaitMs);
  }

  return {
    dispose: clearTimers,
    flush,
    schedule,
  };
}
