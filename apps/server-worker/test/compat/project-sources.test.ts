import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { projectSourceSchema } from "../../src/contract/domain/index.js";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";

/**
 * #445 add-source server face (bb routes/projects.ts:466-591 + routes/hosts.ts:
 * 235-264): the machine-setup / Project Settings flow — POST (clone and
 * local_path arms), PATCH, DELETE on project sources plus the two host
 * discovery routes feeding the dialog (clone-default-path, paths/exist).
 * The success clone roundtrip needs a live daemon socket and is pinned at L1
 * (packages/daemon-service test/project-commands.test.ts); these tests pin
 * the route contract: error shapes, default-source bookkeeping and the
 * destroyed-host data-hygiene ruling on GET /environments.
 */

beforeAll(ensureMigrations);

const apiErrorBodySchema = z.object({ code: z.string() });

async function postJson(path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteJson(path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await exports.default.fetch(`https://example.com${path}`);
  return { status: response.status, body: await response.json() };
}

let seedCounter = 0;

async function seedHost(destroyedAt: number | null = null): Promise<string> {
  seedCounter += 1;
  const id = `host445_${seedCounter}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at) VALUES (?, ?, 'persistent', NULL, 'full', ?, NULL, NULL, ?, ?)",
  )
    .bind(id, `445-${id}`, destroyedAt, now, now)
    .run();
  return id;
}

async function seedProject(): Promise<{ id: string; name: string }> {
  const name = `addsrc-${Math.random().toString(36).slice(2, 8)}`;
  const hostId = await seedHost();
  const created = await postJson("/api/v1/projects", {
    name,
    source: { hostId, type: "local_path", path: `/repo/${name}` },
  });
  expect(created.status).toBe(201);
  const parsed = z.object({ id: z.string() }).parse(await created.json());
  return { id: parsed.id, name };
}

async function sourceCount(projectId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_sources WHERE project_id = ?")
    .bind(projectId)
    .first();
  return Number(row?.n ?? 0);
}

describe("GET /projects (#445): sources are the stored rows, never a stub", () => {
  it("lists the project's sources instead of the M0 hardcoded empty array", async () => {
    const project = await seedProject();
    const listed = await getJson("/api/v1/projects");
    expect(listed.status).toBe(200);
    const rows = z
      .array(z.object({ id: z.string(), sources: z.array(projectSourceSchema) }))
      .parse(listed.body);
    const entry = rows.find((row) => row.id === project.id);
    expect(entry?.sources).toHaveLength(1);
    expect(entry?.sources[0]?.isDefault).toBe(true);
  });
});

describe("POST /projects/:id/sources (#445)", () => {
  it("adds a second host's folder source, keeping the incumbent default", async () => {
    const project = await seedProject();
    const secondHost = await seedHost();
    const created = await postJson(`/api/v1/projects/${project.id}/sources`, {
      type: "local_path",
      hostId: secondHost,
      path: "/repo/second",
    });
    expect(created.status).toBe(201);
    const source = projectSourceSchema.parse(await created.json());
    expect(source.hostId).toBe(secondHost);
    expect(source.path).toBe("/repo/second");
    expect(source.isDefault).toBe(false);
    expect(await sourceCount(project.id)).toBe(2);

    // The read face carries both rows, default intact.
    const detail = await getJson(`/api/v1/projects/${project.id}`);
    const body = z.object({ sources: z.array(projectSourceSchema) }).parse(detail.body);
    expect(body.sources).toHaveLength(2);
    expect(body.sources.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it("409s a duplicate (project, host) with bb's conflict shape", async () => {
    const project = await seedProject();
    const listed = await getJson(`/api/v1/projects/${project.id}`);
    const body = z.object({ sources: z.array(projectSourceSchema) }).parse(listed.body);
    const hostId = body.sources[0]?.hostId ?? "";
    const conflict = await postJson(`/api/v1/projects/${project.id}/sources`, {
      type: "local_path",
      hostId,
      path: "/repo/other",
    });
    expect(conflict.status).toBe(409);
    expect(apiErrorBodySchema.parse(await conflict.json()).code).toBe(
      "project_source_host_conflict",
    );
  });

  it("answers bb's guard shapes for unknown/personal projects and unusable hosts", async () => {
    const missing = await postJson("/api/v1/projects/proj_missing445/sources", {
      type: "local_path",
      hostId: "host_whatever",
      path: "/repo/x",
    });
    expect(missing.status).toBe(404);
    expect(apiErrorBodySchema.parse(await missing.json()).code).toBe("project_not_found");

    const personal = await postJson("/api/v1/projects/proj_personal/sources", {
      type: "local_path",
      hostId: await seedHost(),
      path: "/repo/x",
    });
    expect(personal.status).toBe(404);

    const unknownProject = await seedProject();
    const unknownHost = await postJson(`/api/v1/projects/${unknownProject.id}/sources`, {
      type: "local_path",
      hostId: "host_missing445",
      path: "/repo/x",
    });
    expect(unknownHost.status).toBe(404);
    expect(apiErrorBodySchema.parse(await unknownHost.json()).code).toBe("host_not_found");

    const placeholderProject = await seedProject();
    const placeholder = await postJson(`/api/v1/projects/${placeholderProject.id}/sources`, {
      type: "local_path",
      hostId: CLOUD_PLACEHOLDER_HOST_ID,
      path: "/repo/x",
    });
    expect(placeholder.status).toBe(400);
    expect(apiErrorBodySchema.parse(await placeholder.json()).code).toBe("unsupported_host");
  });

  it("404s a destroyed host with the read-face tombstone shape", async () => {
    const project = await seedProject();
    const destroyed = await seedHost(Date.now());
    const response = await postJson(`/api/v1/projects/${project.id}/sources`, {
      type: "local_path",
      hostId: destroyed,
      path: "/repo/x",
    });
    expect(response.status).toBe(404);
    const body = z
      .object({ code: z.string(), details: z.object({ reason: z.string() }) })
      .parse(await response.json());
    expect(body.code).toBe("host_unavailable");
    expect(body.details.reason).toBe("destroyed");
  });

  it("400s a clone ask when neither the payload nor the project carries a remote", async () => {
    const project = await seedProject();
    const host = await seedHost();
    const response = await postJson(`/api/v1/projects/${project.id}/sources`, {
      type: "clone",
      hostId: host,
    });
    expect(response.status).toBe(400);
    expect(apiErrorBodySchema.parse(await response.json()).code).toBe("missing_git_remote");
  });

  it("fails a clone on an offline host with 502 and leaves no source row", async () => {
    const project = await seedProject();
    const host = await seedHost();
    const before = await sourceCount(project.id);
    const response = await postJson(`/api/v1/projects/${project.id}/sources`, {
      type: "clone",
      hostId: host,
      remoteUrl: "https://example.com/some/repo.git",
    });
    // The in-pool route cannot reach a live daemon socket (compat/c4 FIXME):
    // bb's online-rpc mapping answers 502 host_unavailable, and the clone
    // never lands a row (bb runs the clone before createProjectSource).
    expect(response.status).toBe(502);
    expect(apiErrorBodySchema.parse(await response.json()).code).toBe("host_unavailable");
    expect(await sourceCount(project.id)).toBe(before);
  });
});

describe("PATCH /projects/:id/sources/:sourceId (#445)", () => {
  it("renames a source path and 404s unknown or cross-project ids", async () => {
    const project = await seedProject();
    const listed = await getJson(`/api/v1/projects/${project.id}`);
    const body = z.object({ sources: z.array(projectSourceSchema) }).parse(listed.body);
    const sourceId = body.sources[0]?.id ?? "";

    const renamed = await patchJson(`/api/v1/projects/${project.id}/sources/${sourceId}`, {
      type: "local_path",
      path: "/repo/renamed",
    });
    expect(renamed.status).toBe(200);
    expect(projectSourceSchema.parse(await renamed.json()).path).toBe("/repo/renamed");

    const missing = await patchJson(`/api/v1/projects/${project.id}/sources/src_nope`, {
      type: "local_path",
      path: "/repo/x",
    });
    expect(missing.status).toBe(404);

    const other = await seedProject();
    const cross = await patchJson(`/api/v1/projects/${other.id}/sources/${sourceId}`, {
      type: "local_path",
      path: "/repo/x",
    });
    expect(cross.status).toBe(404);
  });
});

describe("DELETE /projects/:id/sources/:sourceId (#445)", () => {
  it("refuses the last source, deletes non-last, and promotes the default", async () => {
    const project = await seedProject();
    const host2 = await seedHost();
    await postJson(`/api/v1/projects/${project.id}/sources`, {
      type: "local_path",
      hostId: host2,
      path: "/repo/second",
    });
    const listed = await getJson(`/api/v1/projects/${project.id}`);
    const body = z.object({ sources: z.array(projectSourceSchema) }).parse(listed.body);
    const defaultSource = body.sources.find((row) => row.isDefault);
    expect(defaultSource).toBeDefined();

    const deleted = await deleteJson(
      `/api/v1/projects/${project.id}/sources/${defaultSource?.id ?? ""}`,
      {},
    );
    expect(deleted.status).toBe(200);
    expect(await sourceCount(project.id)).toBe(1);

    // The survivor is promoted to default (bb deleteProjectSource).
    const after = await getJson(`/api/v1/projects/${project.id}`);
    const afterBody = z.object({ sources: z.array(projectSourceSchema) }).parse(after.body);
    expect(afterBody.sources[0]?.isDefault).toBe(true);
    expect(afterBody.sources[0]?.hostId).toBe(host2);

    const lastRefusal = await deleteJson(
      `/api/v1/projects/${project.id}/sources/${afterBody.sources[0]?.id ?? ""}`,
      {},
    );
    expect(lastRefusal.status).toBe(409);
    expect(apiErrorBodySchema.parse(await lastRefusal.json()).code).toBe("invalid_request");
  });
});

describe("host discovery routes (#445, bb routes/hosts.ts:235-264)", () => {
  it("clone-default-path answers the guard contract without a live daemon", async () => {
    // The query contract (projectId required) parses at the boundary, before
    // the host lookup — bb's typedRoutes validate the whole request there too.
    const missingQuery = await getJson("/api/v1/hosts/host_missing445/clone-default-path");
    expect(missingQuery.status).toBe(422);

    const missingHost = await getJson(
      `/api/v1/hosts/host_missing445/clone-default-path?projectId=${(await seedProject()).id}`,
    );
    expect(missingHost.status).toBe(404);
    expect(apiErrorBodySchema.parse(await missingHost.body).code).toBe("host_not_found");

    const missingProject = await getJson(
      `/api/v1/hosts/${await seedHost()}/clone-default-path?projectId=proj_missing445`,
    );
    expect(missingProject.status).toBe(404);
    expect(apiErrorBodySchema.parse(await missingProject.body).code).toBe("project_not_found");

    const offline = await getJson(
      `/api/v1/hosts/${await seedHost()}/clone-default-path?projectId=${(await seedProject()).id}`,
    );
    expect(offline.status).toBe(502);
    expect(apiErrorBodySchema.parse(await offline.body).code).toBe("host_unavailable");
  });

  it("paths/exist 422s a malformed body and 502s an offline host", async () => {
    const host = await seedHost();
    const badBody = await postJson(`/api/v1/hosts/${host}/paths/exist`, { paths: [] });
    expect(badBody.status).toBe(422);
    expect(apiErrorBodySchema.parse(await badBody.json()).code).toBe("validation_failed");

    const offline = await postJson(`/api/v1/hosts/${host}/paths/exist`, {
      paths: ["/repo/a"],
    });
    expect(offline.status).toBe(502);
    expect(apiErrorBodySchema.parse(await offline.json()).code).toBe("host_unavailable");
  });
});

describe("GET /environments destroyed-host hygiene (#445 ruling)", () => {
  it("hides rows whose host tombstoned from the list, keeps the id face honest", async () => {
    const liveHost = await seedHost();
    const deadHost = await seedHost(Date.now());
    const project = await seedProject();
    const now = Date.now();
    const envColumns =
      "id, project_id, host_id, path, workspace_provision_type, status, created_at, updated_at";
    await env.DB.prepare(
      `INSERT INTO environments (${envColumns}) VALUES ('env445_live', ?, ?, '/repo/live', 'unmanaged', 'ready', ?, ?)`,
    )
      .bind(project.id, liveHost, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO environments (${envColumns}) VALUES ('env445_dead', ?, ?, '/repo/dead', 'unmanaged', 'ready', ?, ?)`,
    )
      .bind(project.id, deadHost, now, now)
      .run();

    const listed = await getJson(`/api/v1/environments?projectId=${project.id}`);
    expect(listed.status).toBe(200);
    const rows = z.array(z.object({ id: z.string(), hostId: z.string() })).parse(listed.body);
    expect(rows.map((row) => row.id)).toContain("env445_live");
    expect(rows.map((row) => row.id)).not.toContain("env445_dead");

    // The tombstoned binding still resolves by id — existing threads stay
    // readable and answer host_offline honestly (#436 posture).
    const detail = await getJson("/api/v1/environments/env445_dead");
    expect(detail.status).toBe(200);

    await env.DB.prepare(
      "DELETE FROM environments WHERE id IN ('env445_live', 'env445_dead')",
    ).run();
  });
});
