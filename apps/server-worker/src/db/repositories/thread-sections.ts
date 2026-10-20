import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { threadSectionSchema } from "../../contract/api/projects";
import { threadSections } from "../schema";

/**
 * ThreadSections aggregate repository — the drizzle-era data access for
 * `thread_sections` (#595, db campaign T3; schema: src/db/schema.ts, ruling:
 * #593/#591).
 *
 * Deep module: callers see plain records and intent-named methods; every
 * drizzle query builder stays behind this file. Behavior ports the legacy
 * port verbatim (src/db/control-plane.ts section face — bb
 * routes/thread-sections.ts CRUD): list order (createdAt, id), rename
 * answers null for an unknown id, delete answers whether a row vanished.
 *
 * Deleting a section unbinds its threads at the database: the greenfield
 * schema declares `threads.sectionId → thread_sections.id ON DELETE SET NULL`
 * (a section is a standalone dictionary — unbinding is the database's job,
 * no application-side sweep).
 *
 * Record = the wire `threadSectionSchema` verbatim — the stored shape and the
 * API face coincide (#591: no hand-written second shape).
 */

export type ThreadSectionRecord = z.infer<typeof threadSectionSchema>;

export interface CreateThreadSectionArgs {
  id: string;
  name: string;
}

export interface ThreadSectionsRepo {
  list(): Promise<ThreadSectionRecord[]>;
  get(sectionId: string): Promise<ThreadSectionRecord | null>;
  create(args: CreateThreadSectionArgs): Promise<ThreadSectionRecord>;
  /** Unknown id → null. */
  rename(sectionId: string, name: string): Promise<ThreadSectionRecord | null>;
  /** True when a row was deleted; unbinding rides the sectionId SET NULL FK. */
  delete(sectionId: string): Promise<boolean>;
}

export function createThreadSectionsRepo(db: D1Database): ThreadSectionsRepo {
  const drizzleDb = drizzle(db);

  return {
    async list() {
      return await drizzleDb
        .select()
        .from(threadSections)
        .orderBy(asc(threadSections.createdAt), asc(threadSections.id))
        .all();
    },

    async get(sectionId) {
      const row = await drizzleDb
        .select()
        .from(threadSections)
        .where(eq(threadSections.id, sectionId))
        .get();
      return row ?? null;
    },

    async create(args) {
      const now = Date.now();
      await drizzleDb
        .insert(threadSections)
        .values({ id: args.id, name: args.name, createdAt: now, updatedAt: now })
        .run();
      const row = await this.get(args.id);
      if (!row) {
        throw new Error(`thread section ${args.id} missing after insert`);
      }
      return row;
    },

    async rename(sectionId, name) {
      await drizzleDb
        .update(threadSections)
        .set({ name, updatedAt: Date.now() })
        .where(eq(threadSections.id, sectionId))
        .run();
      return await this.get(sectionId);
    },

    async delete(sectionId) {
      const result = await drizzleDb
        .delete(threadSections)
        .where(eq(threadSections.id, sectionId))
        .run();
      return result.meta.changes > 0;
    },
  };
}
