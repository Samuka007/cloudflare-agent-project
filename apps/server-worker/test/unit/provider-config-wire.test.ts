import { describe, expect, it } from "vitest";
import {
  discoverProviderModels,
  probeProviderConnection,
} from "../../src/services/provider-config-test.js";

/**
 * #362 wire faces with a stubbed fetch (the services take a FetchImpl seam
 * so the L1 rig needs no live upstream): envelope normalization, the
 * skip-with-warning discipline for unusable discovered entries, and the
 * credential/verb shapes of both probes.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("#362 probeProviderConnection (test-connection)", () => {
  it("probes anthropic rows on ${baseUrl}/v1/messages with the x-api-key header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const verdict = await probeProviderConnection(
      {
        api: "anthropic",
        baseUrl: "https://up.example.com/",
        model: "claude-panel",
        apiKey: "sk-probe-362",
      },
      (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({ ok: true }));
      },
    );
    expect(verdict.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://up.example.com/v1/messages");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-api-key")).toBe("sk-probe-362");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("probes openai-responses rows on ${baseUrl}/responses with the bearer header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const verdict = await probeProviderConnection(
      {
        api: "openai-responses",
        baseUrl: "https://up.example.com/v1",
        model: "panel-model",
        apiKey: null,
      },
      (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({ ok: true }));
      },
    );
    expect(verdict.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://up.example.com/v1/responses");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("answers a bounded-error verdict on upstream failure", async () => {
    const verdict = await probeProviderConnection(
      { api: "anthropic", baseUrl: "https://up.example.com", model: "m", apiKey: null },
      () => Promise.resolve(jsonResponse({ error: { message: "nope sk-echo-should-not-matter" } }, 401)),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(401);
    expect(verdict.error).toContain("nope");
  });

  it("maps transport failures to a null-status verdict", async () => {
    const verdict = await probeProviderConnection(
      { api: "anthropic", baseUrl: "https://up.example.com", model: "m", apiKey: null },
      () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBeNull();
    expect(verdict.error).toContain("ECONNREFUSED");
  });
});

describe("#362 discoverProviderModels (/models discovery)", () => {
  it("normalizes the OpenAI list envelope into catalog seats", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const verdict = await discoverProviderModels(
      { baseUrl: "https://newapi.example.com/v1/", apiKey: "sk-disc-362" },
      (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          jsonResponse({
            object: "list",
            data: [
              { id: "glm-5.3", object: "model", owned_by: "zhipu" },
              { id: "glm-5.3-air", name: "GLM Air" },
            ],
          }),
        );
      },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.models).toEqual([{ id: "glm-5.3" }, { id: "glm-5.3-air", name: "GLM Air" }]);
    expect(verdict.warnings).toEqual([]);
    expect(calls[0]?.url).toBe("https://newapi.example.com/v1/models");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer sk-disc-362");
  });

  it("reports unusable entries as warnings — never silently dropped", async () => {
    const verdict = await discoverProviderModels(
      { baseUrl: "https://up.example.com", apiKey: null },
      () => Promise.resolve(jsonResponse({ data: [{ id: "good" }, { nope: 1 }, "junk", { id: "" }] })),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.models).toEqual([{ id: "good" }]);
    expect(verdict.warnings).toHaveLength(3);
    expect(verdict.warnings[0]).toContain("skipped, never silently dropped");
  });

  it("answers ok:false on non-list envelopes and non-JSON bodies", async () => {
    const notList = await discoverProviderModels(
      { baseUrl: "https://up.example.com", apiKey: null },
      () => Promise.resolve(jsonResponse({ version: "1.0" })),
    );
    expect(notList.ok).toBe(false);
    expect(notList.error).toContain("models list");

    const notJson = await discoverProviderModels(
      { baseUrl: "https://up.example.com", apiKey: null },
      () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
    );
    expect(notJson.ok).toBe(false);
    expect(notJson.error).toContain("not JSON");
  });

  it("answers ok:false with the upstream status on HTTP errors", async () => {
    const verdict = await discoverProviderModels(
      { baseUrl: "https://up.example.com", apiKey: null },
      () => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(401);
    expect(verdict.models).toEqual([]);
  });
});
