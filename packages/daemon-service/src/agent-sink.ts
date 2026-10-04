import type { ExecutionUpdate, ExecutionUpdateResult } from "@cap/agent-do";
import { DurableObject } from "cloudflare:workers";

/**
 * POC agent-update sink standing in for packages/agent-do's AgentDO in this
 * package's L1 tests and the local smoke. It records every ExecutionUpdate
 * the service DO delivers (durably, so deliveries survive DO restarts during
 * a test) and answers with the non-duplicate ack the real agent DO would
 * give. The integration worker binds AGENT_DO to the real AgentDO instead.
 */
export class TestAgentSinkDO extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS updates (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        payload TEXT NOT NULL
      )`);
  }

  onExecutionUpdate(update: ExecutionUpdate): Promise<ExecutionUpdateResult> {
    this.ctx.storage.sql.exec(
      "INSERT INTO updates (kind, execution_id, payload) VALUES (?, ?, ?)",
      update.kind,
      update.executionId,
      JSON.stringify(update),
    );
    return Promise.resolve({ duplicate: false, acked: true });
  }

  updates(): Promise<(ExecutionUpdate & { seq: number })[]> {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; payload: string }>("SELECT seq, payload FROM updates ORDER BY seq")
      .toArray();
    return Promise.resolve(
      rows.map((row) => ({
        ...(JSON.parse(row.payload) as ExecutionUpdate),
        seq: row.seq,
      })),
    );
  }

  clear(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM updates");
    return Promise.resolve();
  }

  override fetch(): Promise<Response> {
    return Promise.resolve(new Response("TestAgentSinkDO: RPC only", { status: 404 }));
  }
}
