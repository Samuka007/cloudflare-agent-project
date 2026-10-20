import { beforeAll, describe, expect, it } from "vitest";
import { createRepoRig, ensureV2Migrations, uid } from "./helpers";

/**
 * #595 Hosts aggregate — interface-seam behavior pins: the #49 attach bridge
 * (insert-if-absent, presence-only refresh, owner-controlled rename/ceiling,
 * clear-on-successful-open, destroyed-never-resurrected, #386 placeholder
 * refusal), the owner update face, and the tombstone-excluding inventory.
 */

const rig = createRepoRig();
const { hosts } = rig;

beforeAll(async () => {
  await ensureV2Migrations();
});

describe("HostsRepo aggregate (#595)", () => {
  it("upsertAttached inserts a persistent host honoring the self-reported name", async () => {
    const hostId = uid("host");
    await hosts.upsertAttached(hostId, { hostName: "lab-box" });
    const row = await hosts.get(hostId);
    expect(row).toMatchObject({
      id: hostId,
      name: "lab-box",
      type: "persistent",
      destroyedAt: null,
      lastRejectedProtocolVersion: null,
    });
    expect(row?.lastSeenAt).not.toBeNull();
    expect(await hosts.get(uid("host_missing"))).toBeNull();
  });

  it("falls back to the hostId as display name when none reported", async () => {
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    expect((await hosts.get(hostId))?.name).toBe(hostId);
  });

  it("re-attach refreshes presence and preserves owner-controlled fields", async () => {
    const hostId = uid("host");
    await hosts.upsertAttached(hostId, { hostName: "first-name" });
    const renamed = await hosts.update(hostId, {
      name: "owner-rename",
      maxPermissionMode: "accept-edits",
    });
    if (renamed === null) {
      throw new Error("fixture: host row missing after update");
    }
    if (renamed.lastSeenAt === null) {
      throw new Error("fixture: host presence not stamped");
    }
    const firstSeen = renamed.lastSeenAt;
    await hosts.upsertAttached(hostId, { hostName: "daemon-hostname" });
    const after = await hosts.get(hostId);
    if (after === null) {
      throw new Error("fixture: host row missing after re-attach");
    }
    expect(after.name).toBe("owner-rename");
    expect(after.maxPermissionMode).toBe("accept-edits");
    expect(after.lastSeenAt).toBeGreaterThanOrEqual(firstSeen);
    // bb: enroll's upsert preserves a stored rejection; only a successful
    // open (clearRejected) clears it.
    await hosts.update(hostId, { lastRejectedProtocolVersion: 42 });
    await hosts.upsertAttached(hostId);
    expect((await hosts.get(hostId))?.lastRejectedProtocolVersion).toBe(42);
    await hosts.upsertAttached(hostId, { clearRejected: true });
    expect((await hosts.get(hostId))?.lastRejectedProtocolVersion).toBeNull();
  });

  it("never resurrects a destroyed host, presence refresh included", async () => {
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const destroyedAt = Date.now();
    await hosts.update(hostId, { destroyedAt });
    const before = await hosts.get(hostId);
    await hosts.upsertAttached(hostId, { hostName: "zombie", clearRejected: true });
    const after = await hosts.get(hostId);
    expect(after?.destroyedAt).toBe(destroyedAt);
    expect(after?.lastSeenAt).toBe(before?.lastSeenAt);
    expect(after?.name).toBe(before?.name);
  });

  it("refuses the cloud placeholder id entirely (#386)", async () => {
    const seeded = await hosts.get("cloud");
    expect(seeded?.type).toBe("placeholder");
    await hosts.upsertAttached("cloud", { hostName: "impersonator", clearRejected: true });
    const after = await hosts.get("cloud");
    expect(after?.lastSeenAt).toBe(seeded?.lastSeenAt);
    expect(after?.name).toBe(seeded?.name);
    expect(after?.type).toBe("placeholder");
  });

  it("listActive is the tombstone-excluding inventory in (createdAt, id) order", async () => {
    const first = uid("host");
    const second = uid("host");
    const destroyed = uid("host");
    await hosts.upsertAttached(first);
    await hosts.upsertAttached(second);
    await hosts.upsertAttached(destroyed);
    await hosts.update(destroyed, { destroyedAt: Date.now() });
    const activeIds = (await hosts.listActive()).map((host) => host.id);
    expect(activeIds).toContain(first);
    expect(activeIds).toContain(second);
    expect(activeIds).not.toContain(destroyed);
    expect(activeIds.indexOf(first)).toBeLessThan(activeIds.indexOf(second));
  });

  it("update patches fields, bumps updatedAt, answers null for unknown ids", async () => {
    const hostId = uid("host");
    await hosts.upsertAttached(hostId);
    const updated = await hosts.update(hostId, {
      name: "patched",
      lastSeenAt: 1234,
      lastRejectedProtocolVersion: 7,
    });
    if (updated === null) {
      throw new Error("fixture: host row missing after update");
    }
    expect(updated).toMatchObject({
      name: "patched",
      lastSeenAt: 1234,
      lastRejectedProtocolVersion: 7,
    });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
    await hosts.update(hostId, { destroyedAt: Date.now() });
    expect((await hosts.get(hostId))?.destroyedAt).not.toBeNull();
    expect(await hosts.update(uid("host_missing"), { name: "x" })).toBeNull();
  });
});
