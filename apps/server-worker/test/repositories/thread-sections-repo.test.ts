import { beforeAll, describe, expect, it } from "vitest";
import { createRepoRig, ensureV2Migrations, uid } from "./helpers";

/**
 * #595 ThreadSections aggregate — interface-seam behavior pins: dictionary
 * CRUD in (createdAt, id) order and the greenfield FK contract (deleting a
 * section unbinds its threads via threads.sectionId ON DELETE SET NULL — no
 * application-side sweep).
 */

const rig = createRepoRig();
const { sections, projects, threads } = rig;

beforeAll(async () => {
  await ensureV2Migrations();
});

async function createThreadFixture(projectId: string, sectionId: string | null) {
  return await threads.create({
    id: uid("thr"),
    projectId,
    environmentId: null,
    providerId: "rig",
    modelOverride: null,
    reasoningLevelOverride: null,
    title: null,
    titleFallback: null,
    sectionId,
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
  });
}

describe("ThreadSectionsRepo aggregate (#595)", () => {
  it("creates, lists in (createdAt, id) order, and round-trips", async () => {
    const first = await sections.create({ id: uid("sec"), name: "First" });
    const second = await sections.create({ id: uid("sec"), name: "Second" });
    expect(first).toMatchObject({ name: "First" });
    expect(first.createdAt).toBe(first.updatedAt);
    const listed = (await sections.list()).map((section) => section.id);
    expect(listed.indexOf(first.id)).toBeLessThan(listed.indexOf(second.id));
    expect(await sections.get(first.id)).toEqual(first);
    expect(await sections.get(uid("sec_missing"))).toBeNull();
  });

  it("renames sections and answers null for unknown ids", async () => {
    const section = await sections.create({ id: uid("sec"), name: "Before" });
    const renamed = await sections.rename(section.id, "After");
    if (renamed === null) {
      throw new Error("fixture: section row missing after rename");
    }
    expect(renamed.name).toBe("After");
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(renamed.createdAt);
    expect(await sections.rename(uid("sec_missing"), "Ghost")).toBeNull();
  });

  it("delete answers true once, then false", async () => {
    const section = await sections.create({ id: uid("sec"), name: "Doomed" });
    expect(await sections.delete(section.id)).toBe(true);
    expect(await sections.get(section.id)).toBeNull();
    expect(await sections.delete(section.id)).toBe(false);
  });

  it("deleting a section unbinds its threads (sectionId SET NULL FK)", async () => {
    const project = await projects.create({
      id: uid("proj"),
      name: "Rig",
      kind: "standard",
      gitRemoteUrl: null,
    });
    const section = await sections.create({ id: uid("sec"), name: "Bound" });
    const thread = await createThreadFixture(project.id, section.id);
    expect((await threads.get(thread.id))?.sectionId).toBe(section.id);
    await sections.delete(section.id);
    expect((await threads.get(thread.id))?.sectionId).toBeNull();
  });
});
