import type { DaemonThreadEventInput, ThreadEventEnvelope } from "@cap/protocol";
import type { ThreadEventSink } from "./events";

interface EventRow {
  [key: string]: SqlStorageValue;
  seq: number;
  id: string;
  type: string;
  data: string;
  created_at: number;
}

/**
 * Adapter-side derived journal (#575): cap's existing event log shape, owned
 * by the durable DO. `(id)` is the idempotency key; `seq` is DO-owned.
 */
export class DurableEventSink implements ThreadEventSink {
  readonly #sql: SqlStorage;
  #threadId: string;

  constructor(sql: SqlStorage, threadId: string) {
    this.#sql = sql;
    this.#threadId = threadId;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  bindThread(threadId: string): void {
    this.#threadId = threadId;
  }

  append(input: DaemonThreadEventInput): Promise<ThreadEventEnvelope> {
    const existing = this.#rowById(input.id);
    if (existing !== undefined) return Promise.resolve(this.#toEnvelope(existing));
    const seq = this.latestSeq() + 1;
    this.#sql.exec(
      "INSERT INTO events (seq, id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
      seq,
      input.id,
      input.type,
      JSON.stringify(input.data),
      input.createdAt,
    );
    const row = this.#rowById(input.id);
    if (row === undefined) {
      return Promise.reject(new Error(`event ${input.id} was not persisted`));
    }
    return Promise.resolve(this.#toEnvelope(row));
  }

  findSeq(id: string): Promise<number | undefined> {
    return Promise.resolve(this.#rowById(id)?.seq);
  }

  read(sinceSeq: number, limit: number): ThreadEventEnvelope[] {
    const rows = this.#sql
      .exec<EventRow>(
        "SELECT seq, id, type, data, created_at FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
        sinceSeq,
        limit,
      )
      .toArray();
    return rows.map((row) => this.#toEnvelope(row));
  }

  /** Older page: the newest `limit` rows at or below `beforeSeq` (the
   * timeline anchor is included so the route can validate it). */
  readBefore(beforeSeq: number, limit: number): ThreadEventEnvelope[] {
    const rows = this.#sql
      .exec<EventRow>(
        "SELECT seq, id, type, data, created_at FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT ?",
        beforeSeq,
        limit,
      )
      .toArray();
    return rows.reverse().map((row) => this.#toEnvelope(row));
  }

  latestSeq(): number {
    const row = this.#sql
      .exec<{ latest: number | null }>("SELECT MAX(seq) AS latest FROM events")
      .toArray()[0];
    return row?.latest ?? 0;
  }

  #rowById(id: string): EventRow | undefined {
    return this.#sql
      .exec<EventRow>("SELECT seq, id, type, data, created_at FROM events WHERE id = ?", id)
      .toArray()[0];
  }

  #toEnvelope(row: EventRow): ThreadEventEnvelope {
    const data: unknown = JSON.parse(row.data);
    return {
      id: row.id,
      threadId: this.#threadId,
      seq: row.seq,
      type: row.type,
      // The row was written from a validated DaemonThreadEventInput.
      data: data as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }
}
