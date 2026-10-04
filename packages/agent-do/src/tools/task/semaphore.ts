/**
 * T18 session-level spawn semaphore (omp parallel.ts:131-135 +
 * task/index.ts:639-643): one permit covers one SpawnRun, unified across all
 * task calls of the session (sync and background alike). `maxConcurrency`
 * default 32 (task/settings.ts:235-239), 0 = unlimited; acquire-time reads
 * make in-place settings changes apply to already-queued spawns
 * (task/index.ts:639-643). DO-instance state — orchestration face stays in
 * the parent DO per the hybrid split (task semantics §7).
 */
export class SpawnSemaphore {
  private active = 0;
  /** Resolves with a meaningless null — the slot reservation is the signal. */
  private waiters: PromiseWithResolvers<null>[] = [];

  constructor(private maxConcurrency: number) {}

  /** omp in-place resize (task/index.ts:639-643): applies to queued waiters. */
  resize(maxConcurrency: number): void {
    this.maxConcurrency = maxConcurrency;
    this.pump();
  }

  /** Resolves when a permit is held; call the returned releaser exactly once. */
  async acquire(): Promise<() => void> {
    if (this.maxConcurrency > 0 && this.active >= this.maxConcurrency) {
      const waiter = Promise.withResolvers<null>();
      this.waiters.push(waiter);
      await waiter.promise; // the slot was reserved synchronously by pump()
    } else {
      this.active += 1;
    }
    return () => {
      this.active -= 1;
      this.pump();
    };
  }

  /** Currently held permits (DO budget face: peak concurrency ceiling). */
  inFlight(): number {
    return this.active;
  }

  /**
   * Wake queued acquirers into freed slots. Each wake RESERVES the slot
   * synchronously (active += 1 before the waiter's microtask runs) so a
   * resize/release burst can never over-admit past the cap.
   */
  private pump(): void {
    while (this.maxConcurrency > 0 && this.active < this.maxConcurrency) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      this.active += 1;
      waiter.resolve(null);
    }
  }
}
