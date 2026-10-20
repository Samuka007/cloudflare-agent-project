import type { DaemonThreadEventInput, ThreadEventEnvelope } from "@cap/protocol";
import { asc, desc, eq, gt, lte, max } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { ensureJournalSchema } from "./db/bootstrap";
import { events } from "./db/schema";
import type { ThreadEventSink } from "./events";

type EventRow = typeof events.$inferSelect;

/**
 * Adapter-side derived journal (#575): cap's existing event log shape, owned
 * by the durable DO. `(id)` is the idempotency key; `seq` is DO-owned.
 *
 * W6 db campaign T10/#602: the seven handwritten SQL statements went through
 * the drizzle durable-sqlite query builder; the physical schema (column names,
 * types, unique id) is unchanged, so pre-drizzle rows read and append exactly
 * as before. Consumers (`PiEventBridge`, the `getEvents` routes) are untouched.
 */
export class DurableEventSink implements ThreadEventSink {
  readonly #db: DrizzleSqliteDODatabase;
  #threadId: string;

  constructor(storage: DurableObjectStorage, threadId: string) {
    this.#db = drizzle(storage);
    this.#threadId = threadId;
    ensureJournalSchema(this.#db);
  }

  bindThread(threadId: string): void {
    this.#threadId = threadId;
  }

  append(input: DaemonThreadEventInput): Promise<ThreadEventEnvelope> {
    const existing = this.#rowById(input.id);
    if (existing !== undefined) return Promise.resolve(this.#toEnvelope(existing));
    const seq = this.latestSeq() + 1;
    this.#db
      .insert(events)
      .values({
        seq,
        id: input.id,
        type: input.type,
        data: JSON.stringify(input.data),
        createdAt: input.createdAt,
      })
      .run();
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
    const rows = this.#db
      .select()
      .from(events)
      .where(gt(events.seq, sinceSeq))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all();
    return rows.map((row) => this.#toEnvelope(row));
  }

  /** Older page: the newest `limit` rows at or below `beforeSeq` (the
   * timeline anchor is included so the route can validate it). */
  readBefore(beforeSeq: number, limit: number): ThreadEventEnvelope[] {
    const rows = this.#db
      .select()
      .from(events)
      .where(lte(events.seq, beforeSeq))
      .orderBy(desc(events.seq))
      .limit(limit)
      .all();
    return rows.reverse().map((row) => this.#toEnvelope(row));
  }

  latestSeq(): number {
    const row = this.#db
      .select({ latest: max(events.seq) })
      .from(events)
      .get();
    return row?.latest ?? 0;
  }

  #rowById(id: string): EventRow | undefined {
    return this.#db.select().from(events).where(eq(events.id, id)).get();
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
      createdAt: row.createdAt,
    };
  }
}
