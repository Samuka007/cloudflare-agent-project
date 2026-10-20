import { env } from "cloudflare:workers";
import { applyD1Migrations } from "../migrations-ledger";
import {
  createEnvironmentsRepo,
  createHostsRepo,
  createProjectsRepo,
  createThreadSectionsRepo,
  createThreadsRepo,
  type EnvironmentsRepo,
  type HostsRepo,
  type ProjectsRepo,
  type ThreadSectionsRepo,
  type ThreadsRepo,
} from "../../src/db/repositories";

/**
 * Shared rig for the #595 repository interface-seam suites: every suite
 * drives the drizzle-era control plane (env.DB_V2) through the public repo
 * interfaces ONLY — no SQL, no drizzle types, no route assembly. The ledger
 * gate makes the migration apply idempotent across suites (single shared
 * worker context, vitest isolate:false).
 */

/** Distinct-per-test id minting: the shared DB_V2 outlives single tests. */
export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** Lets wall-clock creates land on distinct createdAt ms for ordering pins. */
export function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 2);
  return promise;
}

export interface RepoRig {
  projects: ProjectsRepo;
  hosts: HostsRepo;
  environments: EnvironmentsRepo;
  sections: ThreadSectionsRepo;
  threads: ThreadsRepo;
}

export async function ensureV2Migrations(): Promise<void> {
  await applyD1Migrations(env.DB_V2);
}

export function createRepoRig(): RepoRig {
  const d1 = env.DB_V2;
  return {
    projects: createProjectsRepo(d1),
    hosts: createHostsRepo(d1),
    environments: createEnvironmentsRepo(d1),
    sections: createThreadSectionsRepo(d1),
    threads: createThreadsRepo(d1),
  };
}
