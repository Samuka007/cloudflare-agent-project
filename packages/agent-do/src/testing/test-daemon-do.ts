import { DurableObject } from "cloudflare:workers";
import type { AgentDO } from "../agent-do.js";
import type {
  DaemonServiceClient,
  DispatchOutcome,
  ExecutionUpdate,
  IsolationOpOutcome,
  ToolDispatchRequest,
  ToolResultPayload,
} from "../daemon.js";
import { FakeDaemonClient, FakeDaemonService, FakeHostOS } from "./fake-daemon.js";
import type { FakeJournalOp } from "./fake-daemon.js";

/**
 * The reference fake daemon service as a REAL Durable Object.
 *
 * Ticket #30's production service DO occupies this exact topology: it is a
 * per-machine DO whose own env carries the AGENT_DO binding, and it pushes
 * `onExecutionUpdate` into the agent DO from its own I/O context. Running the
 * fake inside a DO (instead of as an in-process object) is therefore not a
 * convenience — it is what makes the update/ack flow topologically identical
 * to production, and what lets the crash drills evict each side
 * independently (`abortAllDurableObjects` + revive).
 *
 * Test-observability surface (journal, spawn counts, client simulation) is
 * exposed as RPC so tests never need a context-crossing stub created in the
 * wrong scope.
 */

export interface TestDaemonEnv {
  AGENT_DO: DurableObjectNamespace;
}

export class TestDaemonServiceDO extends DurableObject<TestDaemonEnv> {
  private readonly os = new FakeHostOS();
  private readonly service = new FakeDaemonService();
  /** One client incarnation per DO incarnation; dispatch must always find it. */
  private readonly clientInstance: FakeDaemonClient;
  private agentNamespaceReady = false;

  constructor(ctx: DurableObjectState, env: TestDaemonEnv) {
    super(ctx, env);
    this.service.useOs(this.os);
    this.service.useJournalSink((op) => {
      this.persistJournalOp(op);
    });
    this.restoreJournalFromStorage();
    this.clientInstance = new FakeDaemonClient(this.os, this.service);
  }

  /**
   * The execution journal is durable (§1.2): ops mirror into DO SQLite
   * synchronously inside the record path, so a hard-aborted DO revives with
   * its dedup state intact — what the I16/I19 drills assert.
   */
  private persistJournalOp(op: FakeJournalOp): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO service_journal (op_json) VALUES (?)",
      JSON.stringify(op),
    );
  }

  private restoreJournalFromStorage(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS service_journal (
      op_json TEXT NOT NULL
    )`);
    const rows = this.ctx.storage.sql
      .exec<{ op_json: string }>("SELECT op_json FROM service_journal ORDER BY rowid")
      .toArray();
    if (rows.length === 0) return;
    this.service.restoreJournal(rows.map((row) => JSON.parse(row.op_json) as FakeJournalOp));
  }

  private client(): FakeDaemonClient {
    return this.clientInstance;
  }

  private agent(): DurableObjectNamespace {
    return this.env.AGENT_DO;
  }

  /** Wire the update sink lazily, from this DO's own context (topology = prod). */
  private ensureAgentWired(threadId: string): void {
    if (this.agentNamespaceReady) return;
    const stub = this.agent().get(this.agent().idFromName(threadId)) as DurableObjectStub<AgentDO>;
    this.service.attachAgent({
      onExecutionUpdate: (update) => stub.onExecutionUpdate(update),
    });
    this.agentNamespaceReady = true;
  }

  // -- DaemonServiceClient surface (called by the agent DO via stub) --------

  async dispatch(request: ToolDispatchRequest): Promise<DispatchOutcome> {
    this.ensureAgentWired(request.executionId.slice(0, request.executionId.lastIndexOf(":")));
    return this.service.dispatch(request);
  }

  async kill(executionId: string): Promise<void> {
    await this.service.kill(executionId);
  }

  async ackExecution(executionId: string, resultSeq: number): Promise<void> {
    await this.service.ackExecution(executionId, resultSeq);
  }

  async queryUnacked(
    threadId: string,
  ): Promise<{ executionId: string; result: ToolResultPayload }[]> {
    return this.service.queryUnacked(threadId);
  }

  async isolationOp(
    request: Parameters<DaemonServiceClient["isolationOp"]>[0],
  ): Promise<IsolationOpOutcome> {
    return this.service.isolationOp(request);
  }

  // -- client simulation (tests drive the machine side through here) --------

  clientEmitOutput(executionId: string, text: string): void {
    this.client().emitOutput(executionId, text);
  }

  clientExit(executionId: string, result: ToolResultPayload): void {
    this.client().exit(executionId, result);
  }

  clientDisconnect(): void {
    this.client().disconnect();
  }

  clientReconnectSameBoot(): void {
    this.client().reconnectSameBoot();
  }

  async clientRestartNewBoot(): Promise<void> {
    await this.client().restartNewBoot();
  }

  clientResendFrom(executionId: string, offset: number, text: string): void {
    this.client().resendFrom(executionId, offset, text);
  }

  clientReportGap(executionId: string, from: number, to: number): void {
    this.client().reportGap(executionId, from, to);
  }

  clientAddForeignProcess(): { pid: number; pidStartedAt: number } {
    return this.os.addForeignProcess();
  }

  clientReusePid(pid: number): { pid: number; pidStartedAt: number } {
    return this.os.reusePid(pid);
  }

  // -- scenario switches ------------------------------------------------------

  setHostOnline(online: boolean): void {
    this.service.hostOnline = online;
  }

  setSilentExecutionIds(executionIds: string[]): void {
    this.service.silentExecutionIds.clear();
    for (const id of executionIds) this.service.silentExecutionIds.add(id);
  }

  setFailNextAcks(count: number): void {
    this.service.failNextAcks = count;
  }

  dial(hostId: string): { sessionId: string; replaced: boolean } {
    return this.service.dial(hostId, this.client().bootId);
  }

  lapseLease(hostId: string): string[] {
    return this.service.lapseLease(hostId);
  }

  clientMessage(hostId: string, sessionId: string): { accepted: boolean } {
    return this.service.clientMessage(hostId, sessionId);
  }

  // -- observability ----------------------------------------------------------

  journal(): unknown[] {
    return [...this.service.journal];
  }

  spawnAckCount(executionId: string): number {
    return this.service.spawnAckCount(executionId);
  }

  tombstoned(executionId: string): boolean {
    return this.service.tombstoned(executionId);
  }

  derivedState(executionId: string): string {
    return this.service.derivedStateOf(executionId);
  }

  clientSpawnCalls(): string[] {
    return [...this.client().spawnCalls];
  }

  clientKills(): { executionId: string; pid: number; pidStartedAt: number; verified: boolean }[] {
    return [...this.client().kills];
  }

  clientBootId(): string {
    return this.client().bootId;
  }

  evictAndReplayState(executionIds: string[]): {
    statesBefore: Record<string, string>;
    statesAfter: Record<string, string>;
    offsetsBefore: Record<string, number>;
    offsetsAfter: Record<string, number>;
  } {
    const statesBefore: Record<string, string> = {};
    const offsetsBefore: Record<string, number> = {};
    for (const id of executionIds) {
      statesBefore[id] = this.service.derivedStateOf(id);
      offsetsBefore[id] = this.service.ackedOffsetOf(id);
    }
    this.service.evict();
    this.service.replayFromJournal();
    const statesAfter: Record<string, string> = {};
    const offsetsAfter: Record<string, number> = {};
    for (const id of executionIds) {
      statesAfter[id] = this.service.derivedStateOf(id);
      offsetsAfter[id] = this.service.ackedOffsetOf(id);
    }
    return { statesBefore, statesAfter, offsetsBefore, offsetsAfter };
  }
}

/**
 * Type-only view of the stub tests hold — the DO RPC plumbing types it via
 * the class; this alias keeps helper signatures honest without leaking the
 * class into test surface types.
 */
export type TestDaemonServiceStub = DurableObjectStub<TestDaemonServiceDO> &
  DaemonServiceClient & {
    clientEmitOutput(executionId: string, text: string): Promise<void>;
    clientExit(executionId: string, result: ToolResultPayload): Promise<void>;
    clientDisconnect(): Promise<void>;
    clientReconnectSameBoot(): Promise<void>;
    clientRestartNewBoot(): Promise<void>;
    clientResendFrom(executionId: string, offset: number, text: string): Promise<void>;
    clientReportGap(executionId: string, from: number, to: number): Promise<void>;
    clientAddForeignProcess(): Promise<{ pid: number; pidStartedAt: number }>;
    clientReusePid(pid: number): Promise<{ pid: number; pidStartedAt: number }>;
    setHostOnline(online: boolean): Promise<void>;
    setSilentExecutionIds(executionIds: string[]): Promise<void>;
    setFailNextAcks(count: number): Promise<void>;
    dial(hostId: string): Promise<{ sessionId: string; replaced: boolean }>;
    lapseLease(hostId: string): Promise<string[]>;
    clientMessage(hostId: string, sessionId: string): Promise<{ accepted: boolean }>;
    journal(): Promise<unknown[]>;
    spawnAckCount(executionId: string): Promise<number>;
    tombstoned(executionId: string): Promise<boolean>;
    derivedState(executionId: string): Promise<string>;
    clientSpawnCalls(): Promise<string[]>;
    clientKills(): Promise<
      { executionId: string; pid: number; pidStartedAt: number; verified: boolean }[]
    >;
    clientBootId(): Promise<string>;
    evictAndReplayState(executionIds: string[]): Promise<{
      statesBefore: Record<string, string>;
      statesAfter: Record<string, string>;
      offsetsBefore: Record<string, number>;
      offsetsAfter: Record<string, number>;
    }>;
  };

export type { ExecutionUpdate };
