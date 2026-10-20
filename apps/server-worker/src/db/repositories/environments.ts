import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { environmentSchema, type WorkspaceProvisionType } from "../../contract/domain/environment";
import { environments, hosts } from "../schema";

/**
 * Environments aggregate repository — the drizzle-era data access for
 * `environments` (#595, db campaign T3; schema: src/db/schema.ts, ruling:
 * #593/#591).
 *
 * Deep module: callers see plain records and intent-named methods; every
 * drizzle query builder stays behind this file. Behavior ports the legacy
 * port verbatim (src/db/environments.ts — the #288 binding unit of
 * `threads → environments → (hosts × path)`):
 *
 * - the list face is the bindable-workspace inventory, so a row whose host
 *   row is tombstoned must not advertise itself as selectable (#445 data
 *   hygiene — GET /hosts excludes destroyed rows on the same principle);
 *   row-level reads stay unfiltered (an existing thread's binding stays
 *   resolvable/debuggable);
 * - the unique key (project_id, host_id, path) claims a workspace per
 *   project; a NULL path (personal workspace) needs an IS match — SQLite
 *   unique indexes treat NULLs as distinct;
 * - findOrCreate absorbs the create race bb-style (find → create → re-find;
 *   the loser of the unique index re-reads the winner's row).
 *
 * The record is the zod twin of the wire `Environment` face plus the two
 * lifecycle columns the wire omits (destroyAttemptId, retireRequestedAt)
 * (#591: no hand-written second shape).
 */

export const environmentRecordSchema = environmentSchema.extend({
  destroyAttemptId: z.string().nullable(),
  retireRequestedAt: z.number().nullable(),
});
export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;

export interface CreateEnvironmentArgs {
  id: string;
  projectId: string;
  hostId: string;
  path: string | null;
  workspaceProvisionType: WorkspaceProvisionType;
  status?: EnvironmentRecord["status"];
}

export interface ListEnvironmentsFilters {
  projectId?: string;
}

export interface FindEnvironmentArgs {
  projectId: string;
  hostId: string;
  path: string | null;
}

export interface EnvironmentsRepo {
  get(id: string): Promise<EnvironmentRecord | null>;
  list(filters?: ListEnvironmentsFilters): Promise<EnvironmentRecord[]>;
  findByProjectHostPath(args: FindEnvironmentArgs): Promise<EnvironmentRecord | null>;
  create(args: CreateEnvironmentArgs): Promise<EnvironmentRecord>;
  /** bb ensureEnvironment anchor shape: race-absorbing find-or-create. */
  findOrCreate(args: CreateEnvironmentArgs): Promise<EnvironmentRecord>;
}

export function createEnvironmentsRepo(db: D1Database): EnvironmentsRepo {
  const drizzleDb = drizzle(db);

  const repo: EnvironmentsRepo = {
    async get(id) {
      const row = await drizzleDb.select().from(environments).where(eq(environments.id, id)).get();
      return row ?? null;
    },

    async list(filters = {}) {
      const conditions = [
        // #445: a row whose host is destroyed must not advertise itself as
        // selectable; row-level reads stay unfiltered (see module doc).
        inArray(
          environments.hostId,
          drizzleDb.select({ id: hosts.id }).from(hosts).where(isNull(hosts.destroyedAt)),
        ),
        ...(filters.projectId !== undefined ? [eq(environments.projectId, filters.projectId)] : []),
      ];
      return await drizzleDb
        .select()
        .from(environments)
        .where(and(...conditions))
        .orderBy(asc(environments.createdAt), asc(environments.id))
        .all();
    },

    async findByProjectHostPath(args) {
      const row = await drizzleDb
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.projectId, args.projectId),
            eq(environments.hostId, args.hostId),
            // NULL path (personal workspace) needs an IS match — SQLite
            // unique indexes treat NULLs as distinct.
            args.path === null ? isNull(environments.path) : eq(environments.path, args.path),
          ),
        )
        .get();
      return row ?? null;
    },

    async create(args) {
      const now = Date.now();
      await drizzleDb
        .insert(environments)
        .values({
          id: args.id,
          name: null,
          projectId: args.projectId,
          hostId: args.hostId,
          path: args.path,
          managed: false,
          isGitRepo: false,
          isWorktree: false,
          branchName: null,
          baseBranch: null,
          defaultBranch: null,
          mergeBaseBranch: null,
          destroyAttemptId: null,
          retireRequestedAt: null,
          workspaceProvisionType: args.workspaceProvisionType,
          status: args.status ?? "ready",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const row = await repo.get(args.id);
      if (!row) {
        throw new Error(`environment ${args.id} missing after insert`);
      }
      return row;
    },

    async findOrCreate(args) {
      const existing = await repo.findByProjectHostPath(args);
      if (existing !== null) {
        return existing;
      }
      await repo.create(args).catch(async (error: unknown) => {
        // Unique-index race: another create won the same (project, host, path).
        const raced = await repo.findByProjectHostPath(args);
        if (raced === null) {
          throw error;
        }
      });
      const row = await repo.findByProjectHostPath(args);
      if (row === null) {
        throw new Error("environment missing after find-or-create");
      }
      return row;
    },
  };

  return repo;
}
