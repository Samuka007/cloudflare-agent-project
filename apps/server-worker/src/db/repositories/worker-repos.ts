import type { Env } from "../../env";
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
} from "./index";
import { createSettingsRepository, type SettingsRepository } from "./settings";

/**
 * The worker-side accessor over the T3/T4 repositories (#595/#596): one
 * factory set per isolate, keyed on the bindings object (the runtime hands
 * every request the same `env` reference, so the WeakMap holds exactly one
 * drizzle instance per aggregate for the isolate's lifetime).
 *
 * T5 route migration A (#597): the batch faces (threads/projects/hosts/
 * environments + their route-layer services + the daemon attach bridge) read
 * and write the drizzle-era control plane through this seam — call sites see
 * plain records and intent-named methods, zero SQL, zero query builders. The
 * settings/provider faces stay on the legacy DB until T6 (#598), which is
 * why the settings repository rides here already (the T5 route-layer
 * keybinding leak was the one prepare site outside the five aggregates).
 */
export interface WorkerRepos {
  threads: ThreadsRepo;
  projects: ProjectsRepo;
  hosts: HostsRepo;
  environments: EnvironmentsRepo;
  sections: ThreadSectionsRepo;
  settings: SettingsRepository;
}

const cache = new WeakMap<Env, WorkerRepos>();

export function workerRepos(env: Env): WorkerRepos {
  let repos = cache.get(env);
  if (repos === undefined) {
    repos = {
      threads: createThreadsRepo(env.DB_V2),
      projects: createProjectsRepo(env.DB_V2),
      hosts: createHostsRepo(env.DB_V2),
      environments: createEnvironmentsRepo(env.DB_V2),
      sections: createThreadSectionsRepo(env.DB_V2),
      settings: createSettingsRepository(env.DB_V2, env.PROVIDER_CONFIG_MASTER_KEY),
    };
    cache.set(env, repos);
  }
  return repos;
}
