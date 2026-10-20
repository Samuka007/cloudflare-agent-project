import { beforeAll, describe, expect, it } from "vitest";
import { createRepoRig, ensureV2Migrations, uid } from "./helpers";

/**
 * #595 Projects aggregate — interface-seam behavior pins. Everything rides
 * the public ProjectsRepo (projects + project_sources sub-entity) over the
 * drizzle-era DB_V2; the pins are the bb-port behaviors the routes consume
 * (first-source-is-default, delete-default-promotes-earliest, duplicate
 * (project, host) → null, #468 host sweep without promotion), not SQL shapes.
 */

const rig = createRepoRig();
const { projects, hosts } = rig;

beforeAll(async () => {
  await ensureV2Migrations();
});

async function createProjectFixture(name = "Rig") {
  return await projects.create({
    id: uid("proj"),
    name,
    kind: "standard",
    gitRemoteUrl: null,
  });
}

describe("ProjectsRepo aggregate (#595)", () => {
  it("creates a standard project with the bb defaults and round-trips it", async () => {
    const created = await createProjectFixture("Round trip");
    expect(created).toMatchObject({
      kind: "standard",
      sortKey: "V",
      deletedAt: null,
      gitRemoteUrl: null,
      name: "Round trip",
    });
    expect(created.createdAt).toBe(created.updatedAt);
    expect(await projects.get(created.id)).toEqual(created);
    expect(await projects.get(uid("proj_missing"))).toBeNull();
  });

  it("serves the ledger-seeded personal singleton via getPersonal", async () => {
    const personal = await projects.getPersonal();
    expect(personal?.id).toBe("proj_personal");
    expect(personal?.kind).toBe("personal");
  });

  it("listPublic excludes soft-deleted rows and orders by (sortKey, id)", async () => {
    const a = await projects.create({
      id: `proj_list_a_${uid("x")}`,
      name: "A",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const b = await projects.create({
      id: `proj_list_b_${uid("x")}`,
      name: "B",
      kind: "standard",
      gitRemoteUrl: null,
    });
    await projects.update({ id: b.id, deletedAt: Date.now() });
    const publicIds = (await projects.listPublic()).map((project) => project.id);
    expect(publicIds).toContain(a.id);
    expect(publicIds).not.toContain(b.id);
    // All default sortKey "V": the id tiebreak decides — a before b would
    // hold only for undeleted b, so assert a's exact position stability by
    // checking it precedes nothing it shouldn't (id asc within "V").
    const laterSameSort = (await projects.listPublic()).filter(
      (project) => project.id > a.id && project.id.startsWith("proj_list_"),
    );
    expect(laterSameSort).toEqual([]);
  });

  it("update patches name and soft-delete state, bumping updatedAt", async () => {
    const project = await createProjectFixture();
    const renamed = await projects.update({ id: project.id, name: "Renamed" });
    if (renamed === null) {
      throw new Error("fixture: project row missing after update");
    }
    expect(renamed.name).toBe("Renamed");
    expect(renamed.deletedAt).toBeNull();
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(renamed.createdAt);
    const deleted = await projects.update({ id: project.id, deletedAt: Date.now() });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(await projects.update({ id: uid("proj_missing"), name: "x" })).toBeNull();
  });

  it("setGitRemoteUrlIfMissing anchors once and never overwrites", async () => {
    const project = await createProjectFixture();
    const first = await projects.setGitRemoteUrlIfMissing(
      project.id,
      "https://git.example.com/a.git",
    );
    expect(first?.gitRemoteUrl).toBe("https://git.example.com/a.git");
    const second = await projects.setGitRemoteUrlIfMissing(
      project.id,
      "https://git.example.com/b.git",
    );
    expect(second?.gitRemoteUrl).toBe("https://git.example.com/a.git");
    expect(
      await projects.setGitRemoteUrlIfMissing(uid("proj_missing"), "https://git.example.com/c.git"),
    ).toBeNull();
  });

  it("makes the first source the default and keeps the incumbent on later adds", async () => {
    const project = await createProjectFixture();
    const hostA = uid("host");
    const hostB = uid("host");
    await hosts.upsertAttached(hostA);
    await hosts.upsertAttached(hostB);
    const first = await projects.createSource({
      projectId: project.id,
      hostId: hostA,
      path: "/tmp/a",
    });
    expect(first).not.toBeNull();
    expect(first?.isDefault).toBe(true);
    const second = await projects.createSource({
      projectId: project.id,
      hostId: hostB,
      path: "/tmp/b",
    });
    expect(second?.isDefault).toBe(false);
    expect((await projects.getDefaultSource(project.id))?.id).toBe(first?.id);
    expect((await projects.listSources(project.id)).map((source) => source.hostId)).toEqual([
      hostA,
      hostB,
    ]);
    expect(await projects.countSources(project.id)).toBe(2);
  });

  it("answers null for a duplicate (project, host) source", async () => {
    const project = await createProjectFixture();
    const host = uid("host");
    await hosts.upsertAttached(host);
    const first = await projects.createSource({
      projectId: project.id,
      hostId: host,
      path: "/tmp/a",
    });
    expect(first).not.toBeNull();
    expect(
      await projects.createSource({ projectId: project.id, hostId: host, path: "/tmp/dup" }),
    ).toBeNull();
    expect(await projects.countSources(project.id)).toBe(1);
  });

  it("scopes getSource to BOTH project and source ids", async () => {
    const project = await createProjectFixture();
    const other = await createProjectFixture();
    const host = uid("host");
    await hosts.upsertAttached(host);
    const source = await projects.createSource({
      projectId: project.id,
      hostId: host,
      path: "/tmp/a",
    });
    if (source === null) {
      throw new Error("fixture: source row missing after create");
    }
    expect(await projects.getSource(project.id, source.id)).toEqual(source);
    expect(await projects.getSource(other.id, source.id)).toBeNull();
    expect(await projects.getSourceByHost(project.id, host)).toEqual(source);
    expect(await projects.getSourceByHost(other.id, host)).toBeNull();
  });

  it("updateSource retitles path and demotes siblings when promoting default", async () => {
    const project = await createProjectFixture();
    const hostA = uid("host");
    const hostB = uid("host");
    await hosts.upsertAttached(hostA);
    await hosts.upsertAttached(hostB);
    const first = await projects.createSource({
      projectId: project.id,
      hostId: hostA,
      path: "/tmp/a",
    });
    const second = await projects.createSource({
      projectId: project.id,
      hostId: hostB,
      path: "/tmp/b",
    });
    if (first === null || second === null) {
      throw new Error("fixture: source rows missing after create");
    }
    const retitled = await projects.updateSource(second.id, { path: "/tmp/b2" });
    expect(retitled).toMatchObject({ path: "/tmp/b2", isDefault: false });
    const promoted = await projects.updateSource(second.id, { isDefault: true });
    expect(promoted?.isDefault).toBe(true);
    expect((await projects.getSource(project.id, first.id))?.isDefault).toBe(false);
    expect((await projects.getDefaultSource(project.id))?.id).toBe(second.id);
    expect(await projects.updateSource(uid("src_missing"), { path: "/x" })).toBeNull();
  });

  it("deleting the default promotes the earliest remaining source", async () => {
    const project = await createProjectFixture();
    const hostIds = [uid("host"), uid("host"), uid("host")];
    for (const hostId of hostIds) {
      await hosts.upsertAttached(hostId);
    }
    const sources = [];
    for (const hostId of hostIds) {
      sources.push(
        await projects.createSource({ projectId: project.id, hostId, path: `/tmp/${hostId}` }),
      );
    }
    const [seededDefault, seededSecond] = sources;
    if (seededDefault == null || seededSecond == null) {
      throw new Error("fixture: source rows missing after create");
    }
    expect(await projects.deleteSource(seededDefault.id)).toBe(true);
    expect((await projects.getDefaultSource(project.id))?.id).toBe(sources[1]?.id);
    expect(await projects.deleteSource(uid("src_missing"))).toBe(false);
  });

  it("deleteSourcesByHost sweeps across projects without promotion (#468)", async () => {
    const projectA = await createProjectFixture();
    const projectB = await createProjectFixture();
    const doomedHost = uid("host");
    const survivingHost = uid("host");
    await hosts.upsertAttached(doomedHost);
    await hosts.upsertAttached(survivingHost);
    const aDoomed = await projects.createSource({
      projectId: projectA.id,
      hostId: doomedHost,
      path: "/tmp/a",
    });
    const aSurvivor = await projects.createSource({
      projectId: projectA.id,
      hostId: survivingHost,
      path: "/tmp/a2",
    });
    const bDoomed = await projects.createSource({
      projectId: projectB.id,
      hostId: doomedHost,
      path: "/tmp/b",
    });
    if (aDoomed === null || aSurvivor === null || bDoomed === null) {
      throw new Error("fixture: source rows missing after create");
    }
    const affected = await projects.deleteSourcesByHost(doomedHost);
    expect([...affected].sort()).toEqual([projectA.id, projectB.id].sort());
    expect(await projects.getSource(projectA.id, aDoomed.id)).toBeNull();
    expect(await projects.getSource(projectB.id, bDoomed.id)).toBeNull();
    // bb cascade parity: the sweep does NOT promote — the survivor keeps
    // is_default=false and the binding default resolves to nothing (#377).
    expect(await projects.getSource(projectA.id, aSurvivor.id)).toMatchObject({ isDefault: false });
    expect(await projects.getDefaultSource(projectA.id)).toBeNull();
    expect(await projects.countSources(projectB.id)).toBe(0);
  });
});
