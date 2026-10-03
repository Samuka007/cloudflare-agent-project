import type {
  AgentEventRecord,
  AgentEventType,
  AnyAgentEvent,
  BlobRef,
} from "./fsm-events.js";
import { agentEventDataSchemas, isBlobRef, parseAgentEvent } from "./fsm-events.js";

/**
 * Append-only event log on DO SQLite.
 *
 * - Migrations are versioned and managed here; ad-hoc table edits are
 *   forbidden (spec #17 engineering baseline).
 * - `(thread_id, seq)` is the primary key: seqs are contiguous 1..N per
 *   thread (I1); a conflicting insert at an existing seq fails at the
 *   storage layer.
 * - Payloads above `r2BypassBytes` in designated fields bypass the log into
 *   R2; the row stores a {@link BlobRef} resolved transparently on read
 *   (§1.1). Hashing/offload happens before the insert, and the insert itself
 *   is synchronous — combined with the platform confirmation barrier this is
 *   what makes "persist, then push" enforceable by construction (I3, I4).
 */

const MIGRATIONS: readonly { version: number; name: string; statements: readonly string[] }[] = [
  {
    version: 1,
    name: "agent-do-event-log",
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_do_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS events (
         thread_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         id TEXT NOT NULL,
         type TEXT NOT NULL,
         data TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (thread_id, seq)
       ) WITHOUT ROWID`,
    ],
  },
];

/** String fields eligible for the R2 bypass, per event type. */
const BLOBBABLE_FIELD: Partial<Record<AgentEventType, string>> = {
  "model.delta": "text",
  "tool.output": "chunk",
  "tool.result": "output",
};

export class EventLog {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly blobs: R2Bucket | undefined,
    private readonly r2BypassBytes: number,
  ) {
    this.migrate();
  }

  private migrate(): void {
    // Bookkeeping table first — it is not itself migration-tracked.
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_do_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`);
    const applied = new Set(
      this.storage.sql
        .exec<{ version: number }>("SELECT version FROM agent_do_migrations")
        .toArray()
        .map((row) => Number(row.version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.storage.transactionSync(() => {
        for (const statement of migration.statements) {
          this.storage.sql.exec(statement);
        }
        this.storage.sql.exec(
          "INSERT INTO agent_do_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          Date.now(),
        );
      });
    }
  }

  /** Seqs are assigned inside a synchronous transaction: no gaps, no races. */
  async append<TType extends AgentEventType>(
    threadId: string,
    type: TType,
    data: AgentEventRecord<TType>["data"],
    now: number,
  ): Promise<AgentEventRecord<TType>> {
    const validated = agentEventDataSchemas[type].parse(data) as AgentEventRecord<TType>["data"];
    let stored = validated;
    const field = BLOBBABLE_FIELD[type];
    if (field !== undefined) {
      stored = await this.offloadOversize(threadId, stored, field);
    }
    const record: AgentEventRecord<TType> = {
      id: `evt_${crypto.randomUUID()}`,
      threadId,
      seq: 0,
      type,
      data: stored,
      createdAt: now,
    };
    this.storage.transactionSync(() => {
      const next = Number(
        this.storage.sql
          .exec<{ next: number }>(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?",
            threadId,
          )
          .one().next,
      );
      record.seq = next;
      this.storage.sql.exec(
        "INSERT INTO events (thread_id, seq, id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        threadId,
        next,
        record.id,
        record.type,
        JSON.stringify(record.data),
        record.createdAt,
      );
    });
    return record;
  }

  private async offloadOversize<TType extends AgentEventType>(
    threadId: string,
    data: AgentEventRecord<TType>["data"],
    field: string,
  ): Promise<AgentEventRecord<TType>["data"]> {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value !== "string" || isBlobRef(value)) return data;
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes <= this.r2BypassBytes) return data;
    if (this.blobs === undefined) {
      throw new Error(
        `event payload of ${bytes} bytes exceeds r2BypassBytes=${this.r2BypassBytes} but no R2 binding is configured`,
      );
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `blob/${threadId}/${sha256}`;
    await this.blobs.put(key, value);
    return {
      ...(data as Record<string, unknown>),
      [field]: {
        __blob__: { key, size: bytes, sha256 },
      } satisfies BlobRef,
    } as AgentEventRecord<TType>["data"];
  }

  private resolveBlob(ref: BlobRef): Promise<string> {
    if (this.blobs === undefined) {
      throw new Error(`event references R2 blob ${ref.__blob__.key} but no R2 binding is configured`);
    }
    return this.blobs.get(ref.__blob__.key).then((obj) => {
      if (obj === null) {
        throw new Error(`missing R2 blob ${ref.__blob__.key} referenced by event log`);
      }
      return obj.text();
    });
  }

  async read(
    threadId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{ events: AnyAgentEvent[]; latestSeq: number }> {
    const latestSeq = this.maxSeq(threadId);
    const rows = this.storage.sql
      .exec<{
        seq: number;
        id: string;
        type: string;
        data: string;
        created_at: number;
      }>(
        "SELECT seq, id, type, data, created_at FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        threadId,
        sinceSeq,
        limit,
      )
      .toArray();
    const events: AnyAgentEvent[] = [];
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.data);
      let data = parsed as Record<string, unknown>;
      for (const [field, value] of Object.entries(data)) {
        if (isBlobRef(value)) {
          data = { ...data, [field]: await this.resolveBlob(value) };
        }
      }
      events.push(
        parseAgentEvent({
          threadId,
          seq: Number(row.seq),
          id: row.id,
          type: row.type,
          data,
          createdAt: Number(row.created_at),
        }),
      );
    }
    return { events, latestSeq };
  }

  maxSeq(threadId: string): number {
    const row = this.storage.sql
      .exec<{ max: number | null }>(
        "SELECT MAX(seq) AS max FROM events WHERE thread_id = ?",
        threadId,
      )
      .one();
    return row.max === null ? 0 : Number(row.max);
  }

  count(threadId: string): number {
    return Number(
      this.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM events WHERE thread_id = ?",
          threadId,
        )
        .one().n,
    );
  }
}
