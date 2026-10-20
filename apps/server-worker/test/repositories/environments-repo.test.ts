import { beforeAll, describe, expect, it } from "vitest";
import { createRepoRig, ensureV2Migrations, uid } from "./helpers";

/**
 * #595 Environments aggregate — interface-seam behavior pins: bb defaults at
 * birth, the (project, host, path) claim key with the NULL-path IS match,
 * the #445 destroyed-host exclusion on the list face (row reads stay
 * unfiltered), and the race-absorbing findOrCreate anchor.
 */

const rig = createRepoRig();
const { environments, hosts, projects, threads } = rig;

beforeAll(async () => {
  await ensureV2Migrations();
});

describe("EnvironmentsRepo aggregate (#595)", () => {
  it("creates with the bb defaults and round-trips", async () => {
    const project = await projects.create({
      id: uid("proj"),
      name: "Rig",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const created = await environments.create({
      id: uid("env"),
      projectId: project.id,
      hostId,
      path: "/tmp/workspace",
      workspaceProvisionType: "managed-worktree",
    });
    expect(created).toMatchObject({
      name: null,
      managed: false,
      isGitRepo: false,
      isWorktree: false,
      branchName: null,
      baseBranch: null,
      defaultBranch: null,
      mergeBaseBranch: null,
      destroyAttemptId: null,
      retireRequestedAt: null,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
      path: "/tmp/workspace",
    });
    expect(await environments.get(created.id)).toEqual(created);
    expect(await environments.get(uid("env_missing"))).toBeNull();
  });

  it("finds by the (project, host, path) claim key with an IS match for NULL path", async () => {
    const project = await projects.create({
      id: uid("proj"),
      name: "Rig",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const created = await environments.create({
      id: uid("env"),
      projectId: project.id,
      hostId,
      path: null,
      workspaceProvisionType: "personal",
    });
    expect(
      await environments.findByProjectHostPath({ projectId: project.id, hostId, path: null }),
    ).toEqual(created);
    expect(
      await environments.findByProjectHostPath({
        projectId: project.id,
        hostId,
        path: "/tmp/other",
      }),
    ).toBeNull();
    expect(
      await environments.findByProjectHostPath({
        projectId: uid("proj_missing"),
        hostId,
        path: null,
      }),
    ).toBeNull();
  });

  it("list excludes destroyed-host rows, scopes by project, orders (createdAt, id)", async () => {
    const project = await projects.create({
      id: uid("proj"),
      name: "Rig",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const otherProject = await projects.create({
      id: uid("proj"),
      name: "Other",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const aliveHost = uid("host");
    const doomedHost = uid("host");
    await hosts.upsertAttached(aliveHost);
    await hosts.upsertAttached(doomedHost);
    const first = await environments.create({
      id: uid("env"),
      projectId: project.id,
      hostId: aliveHost,
      path: "/tmp/first",
      workspaceProvisionType: "unmanaged",
    });
    const second = await environments.create({
      id: uid("env"),
      projectId: project.id,
      hostId: aliveHost,
      path: "/tmp/second",
      workspaceProvisionType: "unmanaged",
    });
    const doomed = await environments.create({
      id: uid("env"),
      projectId: project.id,
      hostId: doomedHost,
      path: "/tmp/doomed",
      workspaceProvisionType: "unmanaged",
    });
    const stray = await environments.create({
      id: uid("env"),
      projectId: otherProject.id,
      hostId: aliveHost,
      path: "/tmp/stray",
      workspaceProvisionType: "unmanaged",
    });
    await hosts.update(doomedHost, { destroyedAt: Date.now() });

    const scoped = (await environments.list({ projectId: project.id })).map((row) => row.id);
    expect(scoped).toEqual([first.id, second.id]);
    // Row-level reads stay unfiltered (#445): the tombstoned binding stays
    // resolvable/debuggable by id.
    expect(await environments.get(doomed.id)).not.toBeNull();
    const all = await environments.list();
    expect(all.map((row) => row.id)).toContain(stray.id);
    expect(all.map((row) => row.id)).not.toContain(doomed.id);
  });

  it("findOrCreate returns the winner's row when the claim key already exists", async () => {
    const project = await projects.create({
      id: uid("proj"),
      name: "Rig",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const args = {
      projectId: project.id,
      hostId,
      path: "/tmp/claim",
      workspaceProvisionType: "unmanaged" as const,
    };
    const winner = await environments.findOrCreate({ ...args, id: uid("env") });
    const loser = await environments.findOrCreate({ ...args, id: uid("env") });
    expect(loser.id).toBe(winner.id);
    // The claim key held: no second row was created for the same workspace.
    expect((await environments.list({ projectId: project.id })).map((row) => row.id)).toEqual([
      winner.id,
    ]);
  });

  it("threads bind to environments through the repo seam (FK wiring)", async () => {
    const project = await projects.create({
      id: uid("proj"),
      name: "Rig",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const environment = await environments.create({
      id: uid("env"),
      projectId: project.id,
      hostId,
      path: "/tmp/bound",
      workspaceProvisionType: "unmanaged",
    });
    const thread = await threads.create({
      id: uid("thr"),
      projectId: project.id,
      environmentId: environment.id,
      providerId: "rig",
      modelOverride: null,
      reasoningLevelOverride: null,
      title: null,
      titleFallback: null,
      sectionId: null,
      parentThreadId: null,
      sourceThreadId: null,
      originKind: null,
      originPluginId: null,
      visibility: "visible",
    });
    expect((await threads.get(thread.id))?.environmentId).toBe(environment.id);
  });
});
