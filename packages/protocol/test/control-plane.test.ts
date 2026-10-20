import { describe, expect, it } from "vitest";
import {
  agentSnapshotSchema,
  controlPlaneResponseSchema,
  createRpcControlPlaneClient,
  type ControlPlaneFetcher,
  type ControlPlaneRequest,
} from "../src/index";

/**
 * T7 #599: the ControlPlane typed client's Rpc adapter — the half the
 * daemon-service DO runs inside the workers runtime. Pinned here at the
 * wire level: request bodies match controlPlaneRequestSchema, response
 * envelopes validate through controlPlaneResponseSchema (ok AND error),
 * snapshot payloads schema-parse before they reach the caller, and server
 * failures surface as thrown errors — never as silent shape drift.
 */

interface CapturedCall {
  url: string;
  method: string;
  body: string | undefined;
}

/** A fetcher double recording calls and answering from the given handler
 * (the CF Fetcher shape; the body is the string the client serialized). */
function fetcherOf(
  handler: (call: CapturedCall) => Response | Promise<Response>,
): ControlPlaneFetcher & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const call: CapturedCall = {
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return await handler(call);
    },
  };
}

function snapshotHandler(): (call: CapturedCall) => Response {
  return (call) => {
    const body = JSON.parse(call.body ?? "null") as { method: string };
    const parsed = controlPlaneResponseSchema.parse({
      ok: true,
      data:
        body.method === "hosts.markSeen"
          ? null
          : agentSnapshotSchema.parse({
              providers: [
                {
                  id: "p1",
                  displayName: null,
                  baseUrl: "https://upstream.example",
                  api: "openai-responses",
                  serviceTier: false,
                  apiKeyEnc: "enc",
                  models: "[]",
                  createdAt: 1,
                  updatedAt: 2,
                },
              ],
              imageSourceProviderId: null,
              webSearch: null,
              toolCapabilities: null,
            }),
    });
    return new Response(JSON.stringify(parsed), {
      headers: { "content-type": "application/json" },
    });
  };
}

describe("createRpcControlPlaneClient (#599)", () => {
  it("getAgentSnapshot sends the contract request and schema-parses the snapshot", async () => {
    const fetcher = fetcherOf(snapshotHandler());
    const client = createRpcControlPlaneClient(fetcher);

    const snapshot = await client.getAgentSnapshot();

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.method).toBe("POST");
    expect(JSON.parse(fetcher.calls[0]?.body ?? "null")).toEqual({
      method: "agentSnapshot.get",
    });
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.webSearch).toBeNull();
  });

  it("markHostSeen carries the throttled-write args and accepts the empty ok", async () => {
    const requests: ControlPlaneRequest[] = [];
    const fetcher = fetcherOf((call) => {
      requests.push(JSON.parse(call.body ?? "null") as ControlPlaneRequest);
      return new Response(JSON.stringify({ ok: true, data: null }));
    });
    const client = createRpcControlPlaneClient(fetcher);

    await client.markHostSeen({ hostId: "h1", at: 123 });

    expect(requests).toEqual([{ method: "hosts.markSeen", args: { hostId: "h1", at: 123 } }]);
  });

  it("server error envelopes throw with the server's message", async () => {
    const client = createRpcControlPlaneClient(
      fetcherOf(
        () =>
          new Response(
            JSON.stringify({ ok: false, error: { code: "boom", message: "upstream down" } }),
          ),
      ),
    );
    await expect(client.getAgentSnapshot()).rejects.toThrow("upstream down");
  });

  it("shape-drifted payloads fail the boundary parse, never the caller's types", async () => {
    const client = createRpcControlPlaneClient(
      fetcherOf(
        () => new Response(JSON.stringify({ ok: true, data: { providers: "not-an-array" } })),
      ),
    );
    await expect(client.getAgentSnapshot()).rejects.toThrow();
  });

  it("non-JSON bodies fail loudly with the transport status", async () => {
    const client = createRpcControlPlaneClient(
      fetcherOf(() => new Response("gateway timeout", { status: 504 })),
    );
    await expect(client.getAgentSnapshot()).rejects.toThrow("non-JSON response");
  });
});
