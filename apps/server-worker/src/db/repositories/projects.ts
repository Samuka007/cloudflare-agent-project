import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import {
  projectSchema,
  projectSourceSchema,
  type ProjectKind,
} from "../../contract/domain/project";
import { projectSources, projects } from "../schema";

/**
 * Projects aggregate repository — the drizzle-era data access for `projects`
 * and its `project_sources` sub-entity (#595, db campaign T3; schema:
 * src/db/schema.ts, ruling: #593/#591).
 *
 * Deep module: callers see plain records and intent-named methods; every
 * drizzle query builder and SQL byte stays behind this file. Behavior ports
 * the legacy port verbatim (src/db/control-plane.ts + src/db/project-sources.ts
 * → bb packages/db at 8473d8c33) so the T5 route re-point is mechanical:
 *
 * - listPublic excludes soft-deleted rows and orders (sortKey, id);
 * - the first source of a project becomes its default (later adds keep the
 *   incumbent), deleting the default promotes the earliest remaining source,
 *   and a duplicate (project, host) source answers null (the route maps that
 *   to bb's 409 project_source_host_conflict);
 * - deleteSourcesByHost is the #468 host-tombstone sweep: sources vanish
 *   across ALL projects with NO default promotion (bb cascade parity).
 *
 * The source id is minted here (legacy discipline): the aggregate owns its
 * sub-entity identity, callers never fabricate `src_*` ids.
 *
 * Record shapes are zod-derived twins of the domain faces (#591 ruling — no
 * hand-written second copy): the stored extension adds exactly the columns
 * the wire face omits.
 */

export const projectRecordSchema = projectSchema.extend({
  sortKey: z.string(),
  deletedAt: z.number().nullable(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export type ProjectSourceRecord = z.infer<typeof projectSourceSchema>;

export interface CreateProjectArgs {
  id: string;
  name: string;
  kind: ProjectKind;
  gitRemoteUrl: string | null;
}

export interface UpdateProjectArgs {
  id: string;
  name?: string;
  deletedAt?: number | null;
}

export interface CreateProjectSourceArgs {
  projectId: string;
  hostId: string;
  path: string;
}

export interface UpdateProjectSourceArgs {
  path?: string;
  isDefault?: true;
}

export interface ProjectsRepo {
  get(projectId: string): Promise<ProjectRecord | null>;
  /** The personal singleton (ledger-seeded `proj_personal`); null when absent. */
  getPersonal(): Promise<ProjectRecord | null>;
  /** Non-deleted projects ordered by (sortKey, id) — the sidebar inventory. */
  listPublic(): Promise<ProjectRecord[]>;
  create(args: CreateProjectArgs): Promise<ProjectRecord>;
  update(args: UpdateProjectArgs): Promise<ProjectRecord | null>;
  /**
   * bb setProjectGitRemoteUrlIfMissing (data/projects.ts:278-294): the
   * add-source clone/inspect leg anchors the project's git remote — a URL the
   * row already carries is never overwritten.
   */
  setGitRemoteUrlIfMissing(projectId: string, gitRemoteUrl: string): Promise<ProjectRecord | null>;

  listSources(projectId: string): Promise<ProjectSourceRecord[]>;
  /** The project-level workspace binding default (#288 fallback source). */
  getDefaultSource(projectId: string): Promise<ProjectSourceRecord | null>;
  getSourceByHost(projectId: string, hostId: string): Promise<ProjectSourceRecord | null>;
  /** The row must belong to BOTH ids — the cross-project sourceId probe misses. */
  getSource(projectId: string, sourceId: string): Promise<ProjectSourceRecord | null>;
  countSources(projectId: string): Promise<number>;
  /** null = the (project, host) UNIQUE index rejected a duplicate source. */
  createSource(args: CreateProjectSourceArgs): Promise<ProjectSourceRecord | null>;
  updateSource(
    sourceId: string,
    update: UpdateProjectSourceArgs,
  ): Promise<ProjectSourceRecord | null>;
  /** Deleting the default promotes the earliest remaining source. */
  deleteSource(sourceId: string): Promise<boolean>;
  /** #468 host sweep: affected project ids, no default promotion. */
  deleteSourcesByHost(hostId: string): Promise<string[]>;
}

/**
 * D1 surfaces driver violations as Error chains (drizzle may wrap the cause);
 * match like the legacy port did — message text, walking `cause`.
 */
function isUniqueConstraintError(error: unknown, needles: readonly string[]): boolean {
  let messages = "";
  let current: unknown = error;
  while (current instanceof Error) {
    messages += `\n${current.message}`;
    current = current.cause;
  }
  return (
    messages.includes("UNIQUE constraint failed") && needles.every((n) => messages.includes(n))
  );
}

export function createProjectsRepo(db: D1Database): ProjectsRepo {
  const drizzleDb = drizzle(db);

  const repo: ProjectsRepo = {
    async get(projectId) {
      const row = await drizzleDb.select().from(projects).where(eq(projects.id, projectId)).get();
      return row ?? null;
    },

    async getPersonal() {
      const row = await drizzleDb
        .select()
        .from(projects)
        .where(eq(projects.kind, "personal"))
        .get();
      return row ?? null;
    },

    async listPublic() {
      return await drizzleDb
        .select()
        .from(projects)
        .where(isNull(projects.deletedAt))
        .orderBy(asc(projects.sortKey), asc(projects.id))
        .all();
    },

    async create(args) {
      const now = Date.now();
      await drizzleDb
        .insert(projects)
        .values({
          id: args.id,
          kind: args.kind,
          name: args.name,
          gitRemoteUrl: args.gitRemoteUrl,
          sortKey: "V",
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return {
        id: args.id,
        kind: args.kind,
        name: args.name,
        gitRemoteUrl: args.gitRemoteUrl,
        sortKey: "V",
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },

    async update(args) {
      const { id, name, deletedAt } = args;
      await drizzleDb
        .update(projects)
        .set({
          updatedAt: Date.now(),
          ...(name !== undefined ? { name } : {}),
          ...(deletedAt !== undefined ? { deletedAt } : {}),
        })
        .where(eq(projects.id, id))
        .run();
      return await repo.get(id);
    },

    async setGitRemoteUrlIfMissing(projectId, gitRemoteUrl) {
      await drizzleDb
        .update(projects)
        .set({ gitRemoteUrl, updatedAt: Date.now() })
        .where(and(eq(projects.id, projectId), isNull(projects.gitRemoteUrl)))
        .run();
      return await repo.get(projectId);
    },

    async listSources(projectId) {
      return await drizzleDb
        .select()
        .from(projectSources)
        .where(eq(projectSources.projectId, projectId))
        .orderBy(asc(projectSources.createdAt), asc(projectSources.id))
        .all();
    },

    async getDefaultSource(projectId) {
      const row = await drizzleDb
        .select()
        .from(projectSources)
        .where(and(eq(projectSources.projectId, projectId), eq(projectSources.isDefault, true)))
        .orderBy(asc(projectSources.createdAt), asc(projectSources.id))
        .get();
      return row ?? null;
    },

    async getSourceByHost(projectId, hostId) {
      const row = await drizzleDb
        .select()
        .from(projectSources)
        .where(and(eq(projectSources.projectId, projectId), eq(projectSources.hostId, hostId)))
        .get();
      return row ?? null;
    },

    async getSource(projectId, sourceId) {
      const row = await drizzleDb
        .select()
        .from(projectSources)
        .where(and(eq(projectSources.id, sourceId), eq(projectSources.projectId, projectId)))
        .get();
      return row ?? null;
    },

    async countSources(projectId) {
      const rows = await drizzleDb
        .select({ id: projectSources.id })
        .from(projectSources)
        .where(eq(projectSources.projectId, projectId))
        .all();
      return rows.length;
    },

    async createSource(args) {
      const now = Date.now();
      // bb createProjectSource (data/project-sources.ts:36-76): the first
      // source of a project becomes its default; demote-then-insert keeps the
      // invariant without D1 transactions (the UNIQUE(project_id, host_id)
      // index stays the backstop).
      const existing = await repo.countSources(args.projectId);
      const shouldBeDefault = existing === 0;
      if (shouldBeDefault) {
        await drizzleDb
          .update(projectSources)
          .set({ isDefault: false, updatedAt: now })
          .where(eq(projectSources.projectId, args.projectId))
          .run();
      }
      const id = `src_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
      try {
        await drizzleDb
          .insert(projectSources)
          .values({
            id,
            projectId: args.projectId,
            isDefault: shouldBeDefault,
            type: "local_path",
            hostId: args.hostId,
            path: args.path,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } catch (error) {
        if (
          isUniqueConstraintError(error, ["project_sources.project_id", "project_sources.host_id"])
        ) {
          return null;
        }
        throw error;
      }
      const row = await drizzleDb
        .select()
        .from(projectSources)
        .where(eq(projectSources.id, id))
        .get();
      if (!row) {
        throw new Error(`project source ${id} missing after insert`);
      }
      return row;
    },

    async updateSource(sourceId, update) {
      const existing = await drizzleDb
        .select({ projectId: projectSources.projectId })
        .from(projectSources)
        .where(eq(projectSources.id, sourceId))
        .get();
      if (!existing) {
        return null;
      }
      const now = Date.now();
      // bb updateProjectSource (data/project-sources.ts:150-196): isDefault
      // demotes every sibling first.
      if (update.isDefault === true) {
        await drizzleDb
          .update(projectSources)
          .set({ isDefault: false, updatedAt: now })
          .where(
            and(eq(projectSources.projectId, existing.projectId), ne(projectSources.id, sourceId)),
          )
          .run();
      }
      await drizzleDb
        .update(projectSources)
        .set({
          updatedAt: now,
          // path is COALESCE(?, path) in the port — an absent patch keeps the
          // stored path (conditional set, same bytes).
          ...(update.path !== undefined ? { path: update.path } : {}),
          ...(update.isDefault === true ? { isDefault: true } : {}),
        })
        .where(eq(projectSources.id, sourceId))
        .run();
      const row = await drizzleDb
        .select()
        .from(projectSources)
        .where(eq(projectSources.id, sourceId))
        .get();
      return row ?? null;
    },

    async deleteSource(sourceId) {
      const existing = await drizzleDb
        .select({ projectId: projectSources.projectId, isDefault: projectSources.isDefault })
        .from(projectSources)
        .where(eq(projectSources.id, sourceId))
        .get();
      if (!existing) {
        return false;
      }
      await drizzleDb.delete(projectSources).where(eq(projectSources.id, sourceId)).run();
      // bb deleteProjectSource (data/project-sources.ts:232-276): deleting the
      // default promotes the earliest remaining source (created_at, id order).
      if (existing.isDefault) {
        await drizzleDb
          .update(projectSources)
          .set({ isDefault: true, updatedAt: Date.now() })
          .where(
            eq(
              projectSources.id,
              drizzleDb
                .select({ id: projectSources.id })
                .from(projectSources)
                .where(eq(projectSources.projectId, existing.projectId))
                .orderBy(asc(projectSources.createdAt), asc(projectSources.id))
                .limit(1),
            ),
          )
          .run();
      }
      return true;
    },

    async deleteSourcesByHost(hostId) {
      const affected = await drizzleDb
        .selectDistinct({ projectId: projectSources.projectId })
        .from(projectSources)
        .where(eq(projectSources.hostId, hostId))
        .all();
      await drizzleDb.delete(projectSources).where(eq(projectSources.hostId, hostId)).run();
      return affected.map((row) => row.projectId);
    },
  };

  return repo;
}
