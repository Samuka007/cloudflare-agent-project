import { beforeAll, describe, expect, it } from "vitest";
import type { CreateThreadArgs, ThreadRecord } from "../../src/db/repositories";
import type { ThreadTab } from "../../src/contract/api/thread-tabs";
import { createRepoRig, ensureV2Migrations, tick, uid } from "./helpers";

/**
 * #595 Threads aggregate — interface-seam behavior pins (threads ⊃ thread_tabs
 * ⊃ pending push-write): bb list filters/ordering (#337 pinned block), the
 * #288 binding join inlined per row, the bb update change-kind mapping with
 * the #477 flip guards, pin/archive/delete idempotence, #486 override pool,
 * hierarchy depth (bb resolveParentDepth semantics — the greenfield delta vs
 * the port's broken CTE is documented on the repo), tabs compare-and-set,
 * and the #591 monotonic-CAS pending push-write (T8's seam).
 */

const rig = createRepoRig();
const { projects, hosts, environments, threads } = rig;

beforeAll(async () => {
  await ensureV2Migrations();
});

async function createThreadFixture(args: Partial<CreateThreadArgs> = {}): Promise<ThreadRecord> {
  const projectId = args.projectId ?? (await projectFixture());
  return await threads.create({
    id: uid("thr"),
    projectId,
    environmentId: null,
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
    ...args,
  });
}

async function projectFixture(): Promise<string> {
  return (
    await projects.create({ id: uid("proj"), name: "Rig", kind: "standard", gitRemoteUrl: null })
  ).id;
}

/** A structural stand-in: the repo persists tabs as opaque JSON; the tab
 * vocabulary is validated at the wire face, not at the storage seam. */
function tabFixture(label: string): ThreadTab {
  return { kind: "file", id: label, path: `/tmp/${label}.txt` } as unknown as ThreadTab;
}

describe("ThreadsRepo aggregate (#595)", () => {
  it("creates with the bb birth row (read-at-create, badge off) and round-trips", async () => {
    const row = await createThreadFixture({ title: "Fresh" });
    expect(row).toMatchObject({
      status: "starting",
      visibility: "visible",
      pendingSince: null,
      pendingFoldSeq: 0,
      archivedAt: null,
      pinnedAt: null,
      pinSortKey: null,
      deletedAt: null,
      title: "Fresh",
    });
    // bb createThread: the fresh row is born read; the attention clock starts.
    expect(row.lastReadAt).toBe(row.createdAt);
    expect(row.latestAttentionAt).toBe(row.createdAt);
    expect(await threads.get(row.id)).toEqual(row);
    expect(await threads.get(uid("thr_missing"))).toBeNull();
  });

  it("list gates visibility (default visible-only; explicit match overrides)", async () => {
    const project = await projectFixture();
    const visible = await createThreadFixture({ projectId: project, title: "seen" });
    await tick();
    const hidden = await createThreadFixture({ projectId: project, visibility: "hidden" });
    const inProject = async (filters: Parameters<typeof threads.list>[0]) =>
      (await threads.list({ projectId: project, ...filters })).map((row) => row.id);
    expect(await inProject({})).toEqual([visible.id]);
    expect(await inProject({ includeHidden: true })).toEqual([hidden.id, visible.id]);
    expect(await inProject({ visibility: "hidden" })).toEqual([hidden.id]);
  });

  it("list filters by parent, source/origin, section and archive tri-states", async () => {
    const project = await projectFixture();
    const parent = await createThreadFixture({ projectId: project });
    const child = await createThreadFixture({ projectId: project, parentThreadId: parent.id });
    const fork = await createThreadFixture({
      projectId: project,
      sourceThreadId: parent.id,
      originKind: "fork",
      originPluginId: null,
    });
    const pluginChild = await createThreadFixture({
      projectId: project,
      parentThreadId: parent.id,
      originPluginId: "cap-idea",
    });
    const ids = async (filters: Parameters<typeof threads.list>[0]) =>
      (await threads.list({ projectId: project, ...filters })).map((row) => row.id).sort();

    expect(await ids({ hasParent: true })).toEqual([child.id, pluginChild.id].sort());
    expect(await ids({ hasParent: false })).toEqual([fork.id, parent.id].sort());
    expect(await ids({ parentThreadId: parent.id })).toEqual([child.id, pluginChild.id].sort());
    expect(await ids({ sourceThreadId: parent.id })).toEqual([fork.id]);
    expect(await ids({ originKind: "fork" })).toEqual([fork.id]);
    expect(await ids({ originPluginId: "cap-idea" })).toEqual([pluginChild.id]);
    expect(await ids({ unsectioned: true })).toHaveLength(4);

    await threads.setArchived(child.id, true);
    expect(await ids({ archived: true })).toEqual([child.id]);
    expect(await ids({ archived: false })).toHaveLength(3);
  });

  it("orders the #337 way: pinned block (pinSortKey asc), then recency desc", async () => {
    const project = await projectFixture();
    const a = await createThreadFixture({ projectId: project });
    await tick();
    const b = await createThreadFixture({ projectId: project });
    await tick();
    const c = await createThreadFixture({ projectId: project });
    const ids = async (filters: Parameters<typeof threads.list>[0]) =>
      (await threads.list({ projectId: project, ...filters })).map((row) => row.id);

    // Unpinned block: createdAt desc, id desc — recency decides (the #337 fix).
    expect(await ids({})).toEqual([c.id, b.id, a.id]);

    // Pinning hoists rows into the pinned block ordered by the prefirst key.
    const pinnedA = await threads.pin(a.id, 1000);
    expect(pinnedA?.pinSortKey).toBe(`!${(1000).toString(36)}`);
    await threads.pin(b.id, 1100);
    expect(await ids({})).toEqual([a.id, b.id, c.id]);

    // Archived view: [archivedAt desc, id desc], pinned keys irrelevant.
    await tick();
    await threads.setArchived(c.id, true);
    expect(await ids({ archived: true })).toEqual([c.id]);
    expect(await ids({ archived: false })).toEqual([a.id, b.id]);
  });

  it("limit/offset window the ordered list", async () => {
    const project = await projectFixture();
    const a = await createThreadFixture({ projectId: project });
    await tick();
    const b = await createThreadFixture({ projectId: project });
    await tick();
    const c = await createThreadFixture({ projectId: project });
    const idsOf = async (filters: Parameters<typeof threads.list>[0]) =>
      (await threads.list({ projectId: project, ...filters })).map((row) => row.id);
    expect(await idsOf({})).toEqual([c.id, b.id, a.id]);
    expect(await idsOf({ limit: 2, offset: 1 })).toEqual([b.id, a.id]);
  });

  it("inlines the #288 binding join and derives the badge from pending fields", async () => {
    const project = await projectFixture();
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const environment = await environments.create({
      id: uid("env"),
      projectId: project,
      hostId,
      path: "/tmp/bound",
      workspaceProvisionType: "managed-worktree",
    });
    const bound = await createThreadFixture({ projectId: project, environmentId: environment.id });
    const loose = await createThreadFixture({ projectId: project });

    const rows = await threads.list({ projectId: project });
    const boundRow = rows.find((row) => row.id === bound.id);
    const looseRow = rows.find((row) => row.id === loose.id);
    expect(boundRow).toMatchObject({
      environmentHostId: hostId,
      environmentName: null,
      environmentBranchName: null,
      environmentWorkspaceDisplayKind: "managed-worktree",
      hasPendingInteraction: false,
    });
    expect(looseRow).toMatchObject({
      environmentHostId: null,
      environmentName: null,
      environmentBranchName: null,
      environmentWorkspaceDisplayKind: "other",
    });

    const pushed = await threads.pushPendingState(bound.id, { pendingSince: 555, foldSeq: 1 });
    expect(pushed?.outcome).toBe("applied");
    const after = (await threads.list({ projectId: project })).find((row) => row.id === bound.id);
    expect(after?.hasPendingInteraction).toBe(true);

    // The badge read half (#591 T8): per-id pending field reads; ids with no
    // drizzle-era row (and the empty batch) answer nothing/false.
    const badges = await threads.pendingBadges([bound.id, loose.id]);
    expect(badges.get(bound.id)).toBe(true);
    expect(badges.get(loose.id)).toBe(false);
    expect(await threads.pendingBadges([uid("thr_ghost")])).toEqual(new Map());
    expect(await threads.pendingBadges([])).toEqual(new Map());
  });

  it("maps update writes onto bb change kinds for the hub broadcast", async () => {
    const thread = await createThreadFixture({ title: "old" });
    expect((await threads.update(thread.id, { title: "new" }))?.changedKinds).toEqual([
      "title-changed",
    ]);
    expect((await threads.get(thread.id))?.title).toBe("new");
    // sectionId/visibility fold into the same title-changed kind, deduped.
    expect(
      (await threads.update(thread.id, { title: "x", sectionId: null, visibility: "hidden" }))
        ?.changedKinds,
    ).toEqual(["title-changed"]);
    expect((await threads.update(thread.id, { visibility: "visible" }))?.changedKinds).toEqual([
      "title-changed",
    ]);
    expect((await threads.update(thread.id, { parentThreadId: null }))?.changedKinds).toEqual([
      "parent-changed",
    ]);
    expect((await threads.update(thread.id, { environmentId: null }))?.changedKinds).toEqual([
      "environment-changed",
    ]);
    expect((await threads.update(thread.id, { modelOverride: "m" }))?.changedKinds).toEqual([
      "execution-changed",
    ]);
    expect(
      (await threads.update(thread.id, { reasoningLevelOverride: "high" }))?.changedKinds,
    ).toEqual(["execution-changed"]);
    expect((await threads.update(thread.id, { lastReadAt: 42 }))?.changedKinds).toEqual([
      "read-state-changed",
    ]);
    // Status writes ride silently (the settlement owns their broadcast).
    expect((await threads.update(thread.id, { status: "active" }))?.changedKinds).toEqual([]);
    // A no-field update still bumps the row but broadcasts nothing.
    const empty = await threads.update(thread.id, {});
    expect(empty?.changedKinds).toEqual([]);
    expect(await threads.update(uid("thr_missing"), { title: "x" })).toBeNull();
  });

  it("honors the #477 flip guards: a lost race leaves the row standing", async () => {
    const thread = await createThreadFixture();
    // expectedStatus mismatch: the dispatch flip must not resurrect over a
    // settlement that already sealed the row.
    const lost = await threads.update(thread.id, { status: "active", expectedStatus: "idle" });
    expect(lost?.row.status).toBe("starting");
    const won = await threads.update(thread.id, { status: "active", expectedStatus: "starting" });
    expect(won?.row.status).toBe("active");
    if (won === null) {
      throw new Error("fixture: thread row missing after guarded update");
    }
    // expectedUpdatedAt: the send face pins the row version it observed.
    const staleStamp = won.row.updatedAt - 1;
    const stale = await threads.update(thread.id, {
      status: "idle",
      expectedUpdatedAt: staleStamp,
    });
    expect(stale?.row.status).toBe("active");
    const fresh = await threads.update(thread.id, {
      status: "idle",
      expectedUpdatedAt: won.row.updatedAt,
    });
    expect(fresh?.row.status).toBe("idle");
  });

  it("markDeleted is idempotent and drops the row from every list", async () => {
    const project = (await createThreadFixture()).projectId;
    const thread = await createThreadFixture({ projectId: project });
    const deleted = await threads.markDeleted(thread.id);
    expect(deleted?.deletedAt).not.toBeNull();
    expect(await threads.markDeleted(thread.id)).toBeNull();
    expect(
      (await threads.list({ projectId: project, includeHidden: true })).map((row) => row.id),
    ).not.toContain(thread.id);
    expect(await threads.markDeleted(uid("thr_missing"))).toBeNull();
  });

  it("pin/unpin are idempotent with the prefirst order key", async () => {
    const thread = await createThreadFixture();
    const pinned = await threads.pin(thread.id, 1000);
    expect(pinned?.pinnedAt).toBe(1000);
    expect(pinned?.pinSortKey).toBe(`!${(1000).toString(36)}`);
    // A second pin keeps the first order key (bb pinThread idempotence).
    const repinned = await threads.pin(thread.id, 5000);
    expect(repinned?.pinnedAt).toBe(1000);
    const unpinned = await threads.unpin(thread.id);
    expect(unpinned?.pinnedAt).toBeNull();
    expect(unpinned?.pinSortKey).toBeNull();
    const unpinAgain = await threads.unpin(thread.id);
    expect(unpinAgain?.pinnedAt).toBeNull();
    expect(await threads.pin(uid("thr_missing"), null)).toBeNull();
    expect(await threads.unpin(uid("thr_missing"))).toBeNull();
  });

  it("setArchived toggles once and is idempotent", async () => {
    const thread = await createThreadFixture();
    const archived = await threads.setArchived(thread.id, true);
    expect(archived?.archivedAt).not.toBeNull();
    const again = await threads.setArchived(thread.id, true);
    expect(again?.archivedAt).toBe(archived?.archivedAt);
    const restored = await threads.setArchived(thread.id, false);
    expect(restored?.archivedAt).toBeNull();
    expect((await threads.setArchived(thread.id, false))?.archivedAt).toBeNull();
    expect(await threads.setArchived(uid("thr_missing"), true)).toBeNull();
  });

  it("pools distinct stored model overrides across live threads (#486)", async () => {
    const provider = uid("prov");
    const other = uid("prov");
    const modelA = uid("model");
    const modelB = uid("model");
    await createThreadFixture({ providerId: provider, modelOverride: modelA });
    await createThreadFixture({ providerId: other, modelOverride: modelA });
    await createThreadFixture({ providerId: provider, modelOverride: modelB });
    const doomed = await createThreadFixture({ providerId: provider, modelOverride: uid("model") });
    await threads.markDeleted(doomed.id);

    expect([...new Set(await threads.listStoredModelOverrides())]).toContain(modelA);
    expect(await threads.listStoredModelOverrides()).not.toContain(doomed.id);
    const scoped = await threads.listStoredModelOverrides(provider);
    expect([...new Set(scoped)].sort()).toEqual([modelA, modelB].sort());
    expect(await threads.listStoredModelOverrides(other)).toEqual([modelA]);
  });

  it("counts non-deleted assigned children", async () => {
    const parent = await createThreadFixture();
    const childA = await createThreadFixture({ parentThreadId: parent.id });
    await createThreadFixture({ parentThreadId: parent.id });
    const doomed = await createThreadFixture({ parentThreadId: parent.id });
    await threads.markDeleted(doomed.id);
    expect(await threads.countNonDeletedChildren(parent.id)).toBe(2);
    expect(await threads.countNonDeletedChildren(childA.id)).toBe(0);
  });

  it("walks hierarchy depth with bb resolveParentDepth semantics", async () => {
    const root = await createThreadFixture();
    const child = await createThreadFixture({ parentThreadId: root.id });
    const grandchild = await createThreadFixture({ parentThreadId: child.id });
    expect(await threads.hierarchyDepth(root.id)).toBe(1);
    expect(await threads.hierarchyDepth(child.id)).toBe(2);
    expect(await threads.hierarchyDepth(grandchild.id)).toBe(3);
    expect(await threads.hierarchyDepth(uid("thr_missing"))).toBe(0);
  });

  it("stores tabs as opaque JSON with compare-and-set on revision", async () => {
    const thread = await createThreadFixture();
    expect(await threads.getTabs(thread.id)).toEqual({ revision: 0, tabs: [] });

    const tabA = tabFixture("a");
    const first = await threads.replaceTabs({
      threadId: thread.id,
      expectedRevision: 0,
      tabs: [tabA],
    });
    expect(first).toEqual({ outcome: "stored", stored: { revision: 1, tabs: [tabA] } });
    expect(await threads.getTabs(thread.id)).toEqual({ revision: 1, tabs: [tabA] });

    const stale = await threads.replaceTabs({ threadId: thread.id, expectedRevision: 0, tabs: [] });
    expect(stale).toEqual({ outcome: "conflict", revision: 1 });

    const tabB = tabFixture("b");
    const second = await threads.replaceTabs({
      threadId: thread.id,
      expectedRevision: 1,
      tabs: [tabB, tabA],
    });
    expect(second).toEqual({ outcome: "stored", stored: { revision: 2, tabs: [tabB, tabA] } });

    // A nonzero expected revision against a missing row conflicts (no insert).
    const fresh = uid("thr_fresh");
    expect(await threads.replaceTabs({ threadId: fresh, expectedRevision: 3, tabs: [] })).toEqual({
      outcome: "conflict",
      revision: 0,
    });
    expect(await threads.getTabs(fresh)).toEqual({ revision: 0, tabs: [] });
  });

  it("pushes pending state through a monotonic fold-seq CAS (#591)", async () => {
    const thread = await createThreadFixture();
    const before = await threads.get(thread.id);

    const applied = await threads.pushPendingState(thread.id, { pendingSince: 1234, foldSeq: 4 });
    expect(applied).toMatchObject({ outcome: "applied" });
    expect(applied?.row).toMatchObject({ pendingSince: 1234, pendingFoldSeq: 4 });
    // Badge metadata, not content: the push never moves the row clock.
    expect(applied?.row.updatedAt).toBe(before?.updatedAt);

    // A replay of the same seq (DO redelivery) lands nowhere.
    const replay = await threads.pushPendingState(thread.id, { pendingSince: 999, foldSeq: 4 });
    expect(replay?.outcome).toBe("stale");
    expect(replay?.row).toMatchObject({ pendingSince: 1234, pendingFoldSeq: 4 });
    // A late out-of-order retry with an older seq lands nowhere either.
    const late = await threads.pushPendingState(thread.id, { pendingSince: 1, foldSeq: 2 });
    expect(late?.outcome).toBe("stale");

    const cleared = await threads.pushPendingState(thread.id, { pendingSince: null, foldSeq: 9 });
    expect(cleared).toMatchObject({ outcome: "applied" });
    expect(cleared?.row).toMatchObject({ pendingSince: null, pendingFoldSeq: 9 });

    expect(
      await threads.pushPendingState(uid("thr_missing"), { pendingSince: 1, foldSeq: 1 }),
    ).toBeNull();
  });
});
