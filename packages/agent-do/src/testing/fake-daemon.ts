import type {
  DaemonServiceClient,
  DispatchOutcome,
  ExecutionUpdate,
  ToolDispatchRequest,
  ToolResultPayload,
} from "../daemon.js";

/**
 * Reference fake of the daemon-service side of the §8 contract (execution
 * journal semantics, offset dedup, ack-tombstone, lease replace, bootId
 * reconcile, kill-list verification) plus a fake daemon client with an
 * in-memory process table and retransmit buffers.
 *
 * This is a TEST DOUBLE: ticket #30 owns the real service DO. The invariants
 * whose assertion point is the service journal (I16–I22) are pinned here
 * against this reference so the contract cannot drift silently; when the
 * real DO lands, the same tests re-point at it via the same interfaces.
 */

interface AgentUpdateSink {
  onExecutionUpdate(update: ExecutionUpdate): Promise<{ duplicate: boolean; acked: boolean }>;
}

export type FakeJournalOp =
  | { op: "dispatch"; executionId: string; bootId: string; at: number }
  | { op: "spawn_ack"; executionId: string; pid: number; pidStartedAt: number }
  | { op: "output"; executionId: string; offset: number; bytes: number }
  | { op: "output_dup_dropped"; executionId: string; offset: number }
  | { op: "output_gap"; executionId: string; from: number; to: number }
  | { op: "exited"; executionId: string; status: ToolResultPayload["status"] }
  | { op: "outcome_unknown"; executionId: string }
  | { op: "cancel_requested"; executionId: string }
  | { op: "ack"; executionId: string; resultSeq: number }
  | { op: "tombstone"; executionId: string }
  | { op: "orphan_suspect"; executionId: string }
  | { op: "session_replaced"; hostId: string; oldSessionId: string }
  | { op: "stale_session_rejected"; hostId: string };

interface DerivedExecution {
  state: "RUNNING" | "COMPLETED" | "UNKNOWN" | "TOMBSTONE";
  bootId: string;
  lastOffset: number;
  result: ToolResultPayload | null;
  orphanSuspect: boolean;
}

/** OS-level process reality shared across client incarnations. */
export class FakeHostOS {
  readonly processes = new Map<
    number,
    { pid: number; pidStartedAt: number; executionId: string; killed: boolean }
  >();
  private pidSeq = 1000;
  private clockSeq = 10;

  spawn(executionId: string): { pid: number; pidStartedAt: number } {
    this.pidSeq += 1;
    this.clockSeq += 1;
    const process = {
      pid: this.pidSeq,
      pidStartedAt: this.clockSeq,
      executionId,
      killed: false,
    };
    this.processes.set(process.pid, process);
    return { pid: process.pid, pidStartedAt: process.pidStartedAt };
  }

  /** Marker-only process with no journal authorization (I24/I22 negative). */
  addForeignProcess(): { pid: number; pidStartedAt: number } {
    return this.spawn("__foreign__");
  }

  /** pid-reuse trap: same pid number, different start time → must not kill. */
  reusePid(pid: number): { pid: number; pidStartedAt: number } {
    this.clockSeq += 1;
    const process = {
      pid,
      pidStartedAt: this.clockSeq,
      executionId: "__reused__",
      killed: false,
    };
    this.processes.set(pid, process);
    return { pid: process.pid, pidStartedAt: process.pidStartedAt };
  }

  /** Returns true only when pid AND start time match (I22 verification). */
  kill(pid: number, pidStartedAt: number): boolean {
    const process = this.processes.get(pid);
    if (process?.pidStartedAt !== pidStartedAt) return false;
    process.killed = true;
    return true;
  }
}

export class FakeDaemonClient {
  readonly spawnCalls: string[] = [];
  readonly kills: { executionId: string; pid: number; pidStartedAt: number; verified: boolean }[] =
    [];
  bootId = `boot_${crypto.randomUUID()}`;
  disconnected = false;
  /** Buffers are the retransmit source (§8.1): executionId → accumulated bytes. */
  private readonly buffers = new Map<string, { bytes: string; sentOffset: number }>();

  constructor(
    private readonly os: FakeHostOS,
    private readonly service: FakeDaemonService,
  ) {
    service.attachClient(this);
  }

  emitOutput(executionId: string, text: string): void {
    const buffer = this.buffers.get(executionId) ?? { bytes: "", sentOffset: 0 };
    const offset = buffer.bytes.length;
    buffer.bytes += text;
    this.buffers.set(executionId, buffer);
    if (!this.disconnected) {
      this.service.upstreamOutput(executionId, offset, text);
    }
    buffer.sentOffset = buffer.bytes.length;
  }

  exit(executionId: string, result: ToolResultPayload): void {
    if (this.disconnected) return;
    this.service.upstreamExited(executionId, result);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Same-bootId resume (§5.2.2): buffers survive, service tells acked offsets. */
  reconnectSameBoot(): void {
    this.disconnected = false;
    const observed = [...this.service.runningOfBoot(this.bootId)].map((executionId) => ({
      executionId,
    }));
    this.service.resumeFromBuffers(observed, this);
    for (const [executionId, buffer] of this.buffers) {
      const ackedOffset = this.service.ackedOffsetOf(executionId);
      if (buffer.sentOffset < ackedOffset) buffer.sentOffset = ackedOffset;
    }
  }

  /** Explicit-offset resend (§8.3 `exec.resume`); tests drive I20 dedup. */
  resendFrom(executionId: string, offset: number, text: string): void {
    if (this.disconnected) return;
    this.service.upstreamOutput(executionId, offset, text);
  }

  /** Explicit gap marker (§8.3 `output_gap`): lost mid-stream bytes. */
  reportGap(executionId: string, from: number, to: number): void {
    if (this.disconnected) return;
    this.service.upstreamOutputGap(executionId, from, to);
  }

  /**
   * Client restart (§5.2.3): process table and buffers die with the process;
   * the kill-list comes back from the service and is verified against the OS.
   */
  async restartNewBoot(): Promise<void> {
    this.disconnected = false;
    this.buffers.clear();
    this.bootId = `boot_${crypto.randomUUID()}`;
    const killList = this.service.killListForPreviousBoots(this.bootId);
    for (const entry of killList) {
      const verified = this.os.kill(entry.pid, entry.pidStartedAt);
      this.kills.push({ ...entry, verified });
    }
    await this.service.applyKillListOutcome(killList);
  }
}

export class FakeDaemonService implements DaemonServiceClient {
  readonly journal: FakeJournalOp[] = [];
  /** Durable-journal mirror hook (TestDaemonServiceDO persists op JSON). */
  private sink: ((op: FakeJournalOp) => void) | null = null;
  private replaying = false;
  private derived = new Map<string, DerivedExecution>();
  private client: FakeDaemonClient | null = null;
  private agent: AgentUpdateSink | null = null;
  private sessionSeq = 0;
  /** hostId → active session (§8.5: one live session per host). */
  readonly sessions = new Map<string, { sessionId: string; bootId: string }>();
  hostOnline = true;
  /** I15 injection: dispatch is accepted but no update is ever reported. */
  readonly silentExecutionIds = new Set<string>();
  /** I21 injection: fail the next N acks (result stays un-tombstoned). */
  failNextAcks = 0;

  attachClient(client: FakeDaemonClient): void {
    this.client = client;
  }

  /** Wire the agent DO stub results flow into. */
  attachAgent(agent: AgentUpdateSink): void {
    this.agent = agent;
  }

  /** Wire the durable mirror; called with a synchronous DO-SQLite writer. */
  useJournalSink(sink: (op: FakeJournalOp) => void): void {
    this.sink = sink;
  }

  /** Cold start: rebuild journal contents + derived state from durable ops. */
  restoreJournal(ops: readonly FakeJournalOp[]): void {
    this.replaying = true;
    try {
      this.journal.length = 0;
      for (const op of ops) this.record(op);
      this.replayFromJournal();
    } finally {
      this.replaying = false;
    }
  }

  /** The single journal-append path: memory first, then the durable mirror. */
  private record(op: FakeJournalOp): void {
    this.journal.push(op);
    if (!this.replaying) this.sink?.(op);
  }

  private derivedOf(executionId: string): DerivedExecution {
    let record = this.derived.get(executionId);
    if (record === undefined) {
      record = {
        state: "RUNNING",
        bootId: this.client?.bootId ?? "?",
        lastOffset: 0,
        result: null,
        orphanSuspect: false,
      };
      this.derived.set(executionId, record);
    }
    return record;
  }

  runningOfBoot(bootId: string): string[] {
    return [...this.derived.entries()]
      .filter(([, record]) => record.state === "RUNNING" && record.bootId === bootId)
      .map(([executionId]) => executionId);
  }

  ackedOffsetOf(executionId: string): number {
    return this.derivedOf(executionId).lastOffset;
  }

  derivedStateOf(executionId: string): DerivedExecution["state"] {
    return this.derived.get(executionId)?.state ?? "RUNNING";
  }

  // -- wire: client → service (journal first, then forward: §1.2) ----------

  upstreamStarted(executionId: string, pid: number, pidStartedAt: number): void {
    if (this.silentExecutionIds.has(executionId)) return;
    this.record({ op: "spawn_ack", executionId, pid, pidStartedAt });
    void this.agent?.onExecutionUpdate({ kind: "started", executionId, pid, pidStartedAt });
  }

  upstreamOutput(executionId: string, offset: number, chunk: string): void {
    const record = this.derivedOf(executionId);
    if (offset < record.lastOffset) {
      this.record({ op: "output_dup_dropped", executionId, offset });
      return;
    }
    this.record({ op: "output", executionId, offset, bytes: chunk.length });
    record.lastOffset = offset + chunk.length;
    void this.agent?.onExecutionUpdate({ kind: "output", executionId, offset, chunk });
  }

  upstreamOutputGap(executionId: string, from: number, to: number): void {
    this.record({ op: "output_gap", executionId, from, to });
  }

  upstreamExited(executionId: string, result: ToolResultPayload): void {
    const record = this.derivedOf(executionId);
    this.record({ op: "exited", executionId, status: result.status });
    record.state = "COMPLETED";
    record.result = result;
    // Fire-and-forget is the production delivery shape (at-least-once,
    // lossy); the agent side dedups, acks and tombstones asynchronously.
    void this.agent?.onExecutionUpdate({ kind: "exited", executionId, result });
  }

  // -- DaemonServiceClient --------------------------------------------------

  dispatch(request: ToolDispatchRequest): Promise<DispatchOutcome> {
    const record = this.derivedOf(request.executionId);
    if (record.state === "COMPLETED" || record.state === "TOMBSTONE") {
      return Promise.resolve({
        kind: "completed_cached",
        result: record.result ?? {
          status: "error",
          exitCode: null,
          output: "cached-result-missing",
        },
      });
    }
    if (!this.hostOnline) return Promise.resolve({ kind: "host_offline" });
    this.record({
      op: "dispatch",
      executionId: request.executionId,
      bootId: this.client?.bootId ?? "?",
      at: Date.now(),
    });
    if (record.state === "RUNNING" && record.bootId !== (this.client?.bootId ?? "?")) {
      // stale RUNNING from a previous incarnation is re-owned by this boot
      record.bootId = this.client?.bootId ?? "?";
    }
    if (this.client === null) return Promise.resolve({ kind: "accepted" });
    if (
      record.state === "RUNNING" &&
      this.journal.some((op) => op.op === "spawn_ack" && op.executionId === request.executionId)
    ) {
      // re-attach; journal already has the spawn (§3.5)
      return Promise.resolve({ kind: "accepted" });
    }
    this.client.spawnCalls.push(request.executionId);
    const { pid, pidStartedAt } = this.osRef.spawn(request.executionId);
    this.record({ op: "spawn_ack", executionId: request.executionId, pid, pidStartedAt });
    if (this.silentExecutionIds.has(request.executionId)) {
      return Promise.resolve({ kind: "accepted" });
    }
    void this.agent?.onExecutionUpdate({
      kind: "started",
      executionId: request.executionId,
      pid,
      pidStartedAt,
    });
    return Promise.resolve({ kind: "accepted" });
  }

  private osRef: FakeHostOS = new FakeHostOS();

  /** Tests hand the OS in so spawn/kill verification is observable. */
  useOs(os: FakeHostOS): void {
    this.osRef = os;
  }

  kill(executionId: string): Promise<void> {
    this.record({ op: "cancel_requested", executionId });
    if (this.client === null || this.client.disconnected) return Promise.resolve();
    const record = this.derivedOf(executionId);
    if (record.state !== "RUNNING") return Promise.resolve();
    this.client.exit(executionId, {
      status: "cancelled",
      exitCode: null,
      output: "",
    });
    return Promise.resolve();
  }

  ackExecution(executionId: string, resultSeq: number): Promise<void> {
    if (this.failNextAcks > 0) {
      this.failNextAcks -= 1;
      return Promise.reject(new Error("injected ack failure"));
    }
    this.record({ op: "ack", executionId, resultSeq });
    const record = this.derivedOf(executionId);
    if (record.state === "COMPLETED") {
      this.record({ op: "tombstone", executionId });
      record.state = "TOMBSTONE";
    }
    return Promise.resolve();
  }

  queryUnacked(_threadId: string): Promise<{ executionId: string; result: ToolResultPayload }[]> {
    return Promise.resolve(
      [...this.derived.entries()]
        .filter(
          (entry): entry is [string, DerivedExecution & { result: ToolResultPayload }] =>
            entry[1].state === "COMPLETED" && entry[1].result !== null,
        )
        .map(([executionId, record]) => ({
          executionId,
          result: record.result,
        })),
    );
  }

  // -- I19: eviction + deterministic journal replay -------------------------

  evict(): void {
    this.derived = new Map();
  }

  replayFromJournal(): void {
    this.derived = new Map();
    for (const op of this.journal) {
      switch (op.op) {
        case "dispatch": {
          const record = this.derivedOf(op.executionId);
          record.bootId = op.bootId;
          break;
        }
        case "spawn_ack": {
          const record = this.derivedOf(op.executionId);
          record.state = record.state === "COMPLETED" ? "COMPLETED" : "RUNNING";
          break;
        }
        case "output": {
          const record = this.derivedOf(op.executionId);
          record.lastOffset = Math.max(record.lastOffset, op.offset + op.bytes);
          break;
        }
        case "exited": {
          const record = this.derivedOf(op.executionId);
          record.state = "COMPLETED";
          break;
        }
        case "outcome_unknown": {
          const record = this.derivedOf(op.executionId);
          record.state = "UNKNOWN";
          break;
        }
        case "tombstone": {
          const record = this.derivedOf(op.executionId);
          record.state = "TOMBSTONE";
          break;
        }
        case "orphan_suspect": {
          this.derivedOf(op.executionId).orphanSuspect = true;
          break;
        }
        case "ack":
        case "cancel_requested":
        case "output_dup_dropped":
        case "output_gap":
        case "session_replaced":
        case "stale_session_rejected":
          // journal-only markers; nothing to rebuild into derived state
          break;
      }
    }
  }

  // -- I17: lease + replacement semantics -----------------------------------

  dial(hostId: string, bootId: string): { sessionId: string; replaced: boolean } {
    const existing = this.sessions.get(hostId);
    let replaced = false;
    if (existing !== undefined) {
      this.record({ op: "session_replaced", hostId, oldSessionId: existing.sessionId });
      replaced = true;
    }
    this.sessionSeq += 1;
    const sessionId = `sess_${this.sessionSeq}`;
    this.sessions.set(hostId, { sessionId, bootId });
    return { sessionId, replaced };
  }

  /** Rejects messages carried on any non-active sessionId (§5.2.5). */
  clientMessage(hostId: string, sessionId: string): { accepted: boolean } {
    const active = this.sessions.get(hostId);
    if (active?.sessionId !== sessionId) {
      this.record({ op: "stale_session_rejected", hostId });
      return { accepted: false };
    }
    return { accepted: true };
  }

  /** Lease expiry + grace lapse (§5.2.1): mark this boot's RUNNING set. */
  lapseLease(hostId: string): string[] {
    const session = this.sessions.get(hostId);
    if (session === undefined) return [];
    const suspects = this.runningOfBoot(session.bootId);
    for (const executionId of suspects) {
      this.record({ op: "orphan_suspect", executionId });
      this.derivedOf(executionId).orphanSuspect = true;
    }
    return suspects;
  }

  // -- I18/I22: kill-list over old boots ------------------------------------

  killListForPreviousBoots(currentBootId: string): {
    executionId: string;
    pid: number;
    pidStartedAt: number;
  }[] {
    const killList: { executionId: string; pid: number; pidStartedAt: number }[] = [];
    const seenBoots = new Set<string>();
    for (const op of this.journal) {
      if (op.op === "dispatch" && op.bootId !== currentBootId) seenBoots.add(op.bootId);
    }
    for (const op of this.journal) {
      if (op.op === "dispatch" && seenBoots.has(op.bootId)) {
        const record = this.derivedOf(op.executionId);
        if (record.state !== "RUNNING" || record.bootId === currentBootId) continue;
        const ack = this.journal.find(
          (candidate): candidate is Extract<FakeJournalOp, { op: "spawn_ack" }> =>
            candidate.op === "spawn_ack" && candidate.executionId === op.executionId,
        );
        if (ack !== undefined) {
          killList.push({
            executionId: op.executionId,
            pid: ack.pid,
            pidStartedAt: ack.pidStartedAt,
          });
        }
      }
    }
    return killList;
  }

  async applyKillListOutcome(
    killList: { executionId: string; pid: number; pidStartedAt: number }[],
  ): Promise<void> {
    for (const entry of killList) {
      this.record({ op: "outcome_unknown", executionId: entry.executionId });
      const record = this.derivedOf(entry.executionId);
      record.state = "UNKNOWN";
      await this.agent?.onExecutionUpdate({
        kind: "exited",
        executionId: entry.executionId,
        result: { status: "outcome_unknown", exitCode: null, output: "" },
      });
    }
  }

  /** I20: same-boot resume — client resends buffered bytes from ackedOffset. */
  resumeFromBuffers(_observed: { executionId: string }[], _client: FakeDaemonClient): void {
    // Buffered-byte resend is driven directly in tests by calling
    // upstreamOutput with explicit offsets; the journal carries the dedup
    // decisions (output vs output_dup_dropped), which is what I20 asserts.
  }

  // -- test observability ----------------------------------------------------

  spawnAckCount(executionId: string): number {
    return this.journal.filter((op) => op.op === "spawn_ack" && op.executionId === executionId)
      .length;
  }

  tombstoned(executionId: string): boolean {
    return this.derivedStateOf(executionId) === "TOMBSTONE";
  }

  journalOpsFor(executionId: string): FakeJournalOp[] {
    return this.journal.filter(
      (op): op is Extract<FakeJournalOp, { executionId: string }> =>
        "executionId" in op && op.executionId === executionId,
    );
  }
}
