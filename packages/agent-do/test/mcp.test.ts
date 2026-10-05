import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import { setupNetwork } from "@msw/cloudflare";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { LATEST_PROTOCOL_VERSION } from "@cap/mcp/http";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { ModelRequest } from "../src/provider.js";
import { anthropicRequestBody as buildBody } from "../src/relay/wire.js";
import {
  MAX_MCP_TOOL_NAME_LENGTH,
  McpToolSurface,
  createMcpToolName,
  decodeMcpServersConfig,
  limitMcpOutput,
  projectMcpToolOutput,
  toMcpInputParameters,
  truncateMcpText,
  type McpServerConfig,
} from "../src/tools/mcp.js";
import { MAIN_WIRE_TOOLS, wireToolSet, M0_RENDER_FLAGS } from "../src/tools/registry.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";

/**
 * Matrix C2 (#327) — the edge MCP client: config decode, wire-name
 * projection (pi tools.ts parity), the discovered surface on the wire, and
 * the DO-bound end-to-end (agent calls an MCP server's tool through the
 * Streamable HTTP transport over the MSW seam — the same mock-provider rig
 * the web_search L1 uses; the vendored @cap/mcp suite carries the transport
 * and client protocol breadth against real sockets).
 */

const network = setupNetwork();

beforeAll(() => {
  network.enable();
});

afterEach(() => {
  resetRuntime();
  network.resetHandlers();
});

afterAll(() => {
  network.disable();
});

// ---------------------------------------------------------------------------
// Reference MCP server over MSW — the streamable-http POST/GET/DELETE faces
// (session header discipline included: the id initialize issues must ride
// every subsequent call).
// ---------------------------------------------------------------------------

const MCP_URL = "https://mcp.demo.test/mcp";

/** The server config the DO-bound tests inject (decoded-shape literal). */
const SERVERS_UNBOUND: McpServerConfig[] = [{ name: "demo", url: MCP_URL, timeoutSeconds: 5 }];

/** One JSON-RPC request/response message over the wire (handler-side view). */
interface JsonRpcMessageView {
  id?: number;
  method?: string;
  params?: { arguments?: Record<string, unknown> };
}

function mcpServerHandlers(options: { callStatus?: number } = {}) {
  let issuedSession: string | undefined;
  const json = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    HttpResponse.json(body, { headers });
  return [
    http.post(MCP_URL, async ({ request }) => {
      const message = (await request.json()) as JsonRpcMessageView;
      if (message.id === undefined) return new HttpResponse(null, { status: 202 });
      if (message.method === "initialize") {
        issuedSession = `session-${issuedSession === undefined ? 1 : 2}`;
        return json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "demo-mcp", version: "1.0.0" },
            },
          },
          { "mcp-session-id": issuedSession },
        );
      }
      if (issuedSession !== undefined) {
        expect(request.headers.get("mcp-session-id")).toBe(issuedSession);
      }
      if (message.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "add",
                description: "Add two numbers.",
                inputSchema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                  required: ["a", "b"],
                },
              },
            ],
          },
        });
      }
      if (message.method === "tools/call") {
        if (options.callStatus !== undefined) {
          return new HttpResponse("boom", { status: options.callStatus });
        }
        const params = message.params;
        const a = Number(params?.arguments?.a ?? 0);
        const b = Number(params?.arguments?.b ?? 0);
        return json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: String(a + b) }],
            structuredContent: { sum: a + b },
          },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method ?? "?"}` },
      });
    }),
    // The server-to-client GET stream: 405 = "not supported" (upstream
    // fixture posture — the transport treats it as no GET stream).
    http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
    http.delete(MCP_URL, () => new HttpResponse(null, { status: 200 })),
  ];
}

// ---------------------------------------------------------------------------
// L1 — config decode (deployment env → McpServerConfig[])
// ---------------------------------------------------------------------------

describe("matrix C2 — config decode", () => {
  test("absent/empty env decodes to no servers", () => {
    expect(decodeMcpServersConfig(undefined)).toEqual([]);
    expect(decodeMcpServersConfig("")).toEqual([]);
  });

  test("valid array decodes with defaults and clamps", () => {
    const servers = decodeMcpServersConfig(
      JSON.stringify([
        { name: "demo", url: MCP_URL },
        {
          name: "ctx7",
          url: "https://mcp.context7.test/mcp",
          headers: { authorization: "Bearer x" },
          timeoutSeconds: 9999,
        },
      ]),
    );
    expect(servers).toEqual([
      { name: "demo", url: MCP_URL, timeoutSeconds: 60 },
      {
        name: "ctx7",
        url: "https://mcp.context7.test/mcp",
        headers: { authorization: "Bearer x" },
        timeoutSeconds: 300,
      },
    ]);
  });

  test("malformed shapes and duplicate names throw (fail loud, never shrink)", () => {
    expect(() => decodeMcpServersConfig("not json")).toThrow();
    expect(() => decodeMcpServersConfig(JSON.stringify({ name: "demo" }))).toThrow();
    expect(() => decodeMcpServersConfig(JSON.stringify([{ name: "demo" }]))).toThrow();
    expect(() =>
      decodeMcpServersConfig(
        JSON.stringify([
          { name: "demo", url: MCP_URL },
          { name: "demo", url: "https://other.test/mcp" },
        ]),
      ),
    ).toThrow(/duplicate server name/);
  });
});

// ---------------------------------------------------------------------------
// L1 — wire-name projection (pi tools.ts:78-93 parity) + schema/output ports
// ---------------------------------------------------------------------------

describe("matrix C2 — wire-name projection (pi createMcpToolName parity)", () => {
  test("sanitizes everything outside [A-Za-z0-9_] into underscores", async () => {
    expect(await createMcpToolName("context7", "resolve-library-id")).toBe(
      "mcp__context7__resolve_library_id",
    );
    expect(await createMcpToolName("my server", "tool.name")).toBe("mcp__my_server__tool_name");
  });

  test("names at the 64-char provider cap pass through untouched", async () => {
    const server = "s".repeat(20);
    const tool = "t".repeat(35); // 5 + 20 + 2 + 35 = 62
    expect(await createMcpToolName(server, tool)).toHaveLength(62);
  });

  test("overlong names are shortened with a stable hash suffix", async () => {
    const server = "s".repeat(40);
    const tool = "t".repeat(40);
    const first = await createMcpToolName(server, tool);
    const second = await createMcpToolName(server, tool);
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
    expect(first).toMatch(/_[0-9a-f]{8}$/);
    // pi layout: the sanitized prefix (cut to cap − 9) + `_` + 8 hex.
    expect(first.startsWith(`mcp__${"s".repeat(40)}__${"t".repeat(8)}_`)).toBe(true);
  });

  test("sanitization collisions (a-b vs a_b) get distinct names", async () => {
    const a = await createMcpToolName("srv", "a-b", (name) => name === "mcp__srv__a_b");
    const b = await createMcpToolName("srv", "a_b", (name) => name === "mcp__srv__a_b");
    expect(a).not.toBe(b);
  });

  test("input schemas are object-guaranteed with default properties (pi toParameters)", () => {
    expect(toMcpInputParameters({ type: "object" })).toEqual({ type: "object", properties: {} });
    expect(toMcpInputParameters({ properties: { a: { type: "number" } } })).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
    });
  });
});

describe("matrix C2 — output projection (pi limitMcpContent posture)", () => {
  test("text blocks join; non-text blocks are named; structured content backs an empty text", () => {
    expect(projectMcpToolOutput({ content: [{ type: "text", text: "5" }] })).toBe("5");
    expect(
      projectMcpToolOutput({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "Zm9v", mimeType: "image/png" },
          { type: "resource_link", uri: "file:///x", name: "x" },
        ],
      }),
    ).toBe("a\n[image: image/png]\n[resource link: file:///x]");
    expect(projectMcpToolOutput({ content: [], structuredContent: { sum: 5 } })).toBe('{"sum":5}');
    expect(projectMcpToolOutput({ content: [] })).toBe("");
  });

  test("overlong output middle-truncates with the pi warning header", () => {
    const text = "x".repeat(30_000);
    const limited = limitMcpOutput(text);
    expect(limited).toContain("Warning: truncated output");
    expect(limited.length).toBeLessThan(text.length);
    const truncation = truncateMcpText(text, 1_000);
    expect(truncation.truncated).toBe(true);
    expect(truncation.totalBytes).toBe(30_000);
    expect(new TextEncoder().encode(truncation.content).byteLength).toBeLessThanOrEqual(1_050);
    expect(truncateMcpText("short", 1_000).truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire assembly — the discovered surface rides AFTER the registry rows
// ---------------------------------------------------------------------------

describe("matrix C2 — wire assembly appends the MCP surface", () => {
  test("mcpTools render after the registry rows, verbatim", () => {
    const request: ModelRequest = {
      threadId: "t",
      turnId: "u",
      modelCallId: 1,
      input: "hi",
      inputImages: [],
      steers: [],
      priorCalls: [],
      asyncResults: [],
      mcpTools: [
        {
          name: "mcp__demo__add",
          description: "Add two numbers.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    };
    // A non-native-reasoning model keeps the full registry surface (the glm
    // family would filter `think` — supportsExternalThinking) so the slice
    // below compares against the unfiltered MAIN_WIRE_TOOLS rendering.
    const body = buildBody(request, { model: "claude-sonnet-4-5", maxTokens: 16 });
    if (body.tools === undefined) throw new Error("tools omitted on a non-empty surface");
    const names = body.tools.map((tool) => tool.name);
    expect(names.slice(0, MAIN_WIRE_TOOLS.length)).toEqual(
      wireToolSet(M0_RENDER_FLAGS, MAIN_WIRE_TOOLS).map((tool) => tool.name),
    );
    expect(names.slice(MAIN_WIRE_TOOLS.length)).toEqual(["mcp__demo__add"]);
    // Absent field = byte-identical pre-C2 shape.
    const without = buildBody(
      { ...request, mcpTools: undefined },
      {
        model: "claude-sonnet-4-5",
        maxTokens: 16,
      },
    );
    if (without.tools === undefined) throw new Error("tools omitted without mcpTools");
    expect(without.tools.map((tool) => tool.name)).toEqual(names.slice(0, MAIN_WIRE_TOOLS.length));
  });
});

// ---------------------------------------------------------------------------
// Surface — discovery, routes, calls over the MSW-served reference server
// ---------------------------------------------------------------------------

describe("matrix C2 — McpToolSurface discovery and calls", () => {
  const SERVERS: McpServerConfig[] = [{ name: "demo", url: MCP_URL, timeoutSeconds: 5 }];

  test("discovery projects the server's tools with sanitized names and routes", async () => {
    network.use(...mcpServerHandlers());
    const surface = new McpToolSurface(SERVERS);
    const tools = await surface.wireTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "mcp__demo__add",
      description: "Add two numbers.",
      input_schema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    });
    expect(surface.routeOf("mcp__demo__add")).toMatchObject({ tool: "add" });
    expect(surface.routeOf("mcp__demo__missing")).toBeUndefined();
  });

  test("calls round-trip through the transport and project the result text", async () => {
    network.use(...mcpServerHandlers());
    const surface = new McpToolSurface(SERVERS);
    await surface.wireTools();
    const route = surface.routeOf("mcp__demo__add");
    if (route === undefined) throw new Error("route missing");
    const result = await surface.callTool(route, { a: 2, b: 3 });
    expect(projectMcpToolOutput(result)).toBe("5");
  });

  test("a failing server is excluded this turn; the empty-config surface is inert", async () => {
    const errorSpy: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => errorSpy.push(parts.join(" "));
    try {
      network.use(http.post(MCP_URL, () => new HttpResponse("down", { status: 500 })));
      const surface = new McpToolSurface(SERVERS);
      expect(await surface.wireTools()).toEqual([]);
      expect(errorSpy.some((line) => line.includes('server "demo" discovery failed'))).toBe(true);
      expect(surface.routeOf("mcp__demo__add")).toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(new McpToolSurface([]).enabled).toBe(false);
    expect(await new McpToolSurface([]).wireTools()).toEqual([]);
  });

  test("a server error on tools/call surfaces as a rejected call (error result text)", async () => {
    network.use(...mcpServerHandlers({ callStatus: 500 }));
    const surface = new McpToolSurface(SERVERS);
    await surface.wireTools();
    const route = surface.routeOf("mcp__demo__add");
    if (route === undefined) throw new Error("route missing");
    await expect(surface.callTool(route, { a: 2, b: 3 })).rejects.toThrow(/status 500/);
  });
});

// ---------------------------------------------------------------------------
// DO-bound end-to-end — the agent calls the MCP tool; replay is journal-only
// ---------------------------------------------------------------------------

function toolResultOf(events: readonly AnyAgentEvent[], threadId: string, tool: string) {
  const call = [...events]
    .reverse()
    .find((event) => event.type === "tool.call" && event.data.tool === tool);
  if (call?.type !== "tool.call") throw new Error(`no tool.call for ${tool}`);
  const executionId = executionIdFor(threadId, call.seq);
  const result = events.find(
    (event) => event.type === "tool.result" && event.data.executionId === executionId,
  );
  if (result?.type !== "tool.result") throw new Error(`no tool.result for ${tool}`);
  return { call, result };
}

describe("matrix C2 — edge execution end-to-end", () => {
  /**
   * Test seam: `mcpSurface` is a private constructor-bound field (deployment
   * env is unset in the rig); tests inject through the same named shape the
   * replay seam uses. Named (not inline) per the cast discipline — the shape
   * is exactly the field being replaced.
   */
  interface SurfaceSeam {
    mcpSurface: McpToolSurface;
  }

  async function injectSurface(stub: Rig["stub"]): Promise<void> {
    await runInDurableObject(stub, (instance) => {
      const seam = instance as unknown as SurfaceSeam;
      seam.mcpSurface = new McpToolSurface(SERVERS_UNBOUND);
    });
  }

  test("agent calls mcp__demo__add; result journals ok; replay answers from the journal", async () => {
    network.use(...mcpServerHandlers());
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "mcp__demo__add", arguments: { a: 2, b: 3 } }] },
        { deltas: ["done"] },
      ],
    });
    // Inject the deployment surface (env AGENT_DO_MCP_SERVERS is unset in the
    // test rig; the decode→constructor path is covered by the L1 above).
    await injectSurface(rig.stub);
    const sent = await rig.stub.sendMessage({
      clientRequestId: "mcp-e2e",
      content: [{ type: "text", text: "add via mcp" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const threadId = events[0]?.threadId;
    if (threadId === undefined) throw new Error("empty event list");

    const { result } = toolResultOf(events, threadId, "mcp__demo__add");
    expect(result.data.status).toBe("ok");
    expect(result.data.exitCode).toBeNull();
    expect(result.data.output).toBe("5");

    // Zero daemon touches: edge execution never leaves this DO.
    await expect(rig.service.journal()).resolves.toEqual([]);
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);

    // Replay: eviction re-derives the identical log; re-asking the terminal
    // execution answers from the journal — zero second MCP round-trips.
    const before = events;
    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(after.map((event) => [event.seq, event.type, event.id])).toEqual(
      before.map((event) => [event.seq, event.type, event.id]),
    );
    const { call } = toolResultOf(after, threadId, "mcp__demo__add");
    const executionId = executionIdFor(threadId, call.seq);
    await runInDurableObject(rig.stub, async (instance) => {
      const seam = instance as unknown as {
        dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
      };
      await seam.dispatchExecution(sent.turnId, executionId);
    });
    const replayed = await rig.events();
    expect(replayed).toHaveLength(after.length);
    const { result: replayResult } = toolResultOf(replayed, threadId, "mcp__demo__add");
    expect(replayResult.data.output).toBe("5");
  });

  test("a wire name whose route died fails closed with a structured error", async () => {
    network.use(...mcpServerHandlers());
    const rig = await createRig({
      turns: [{ toolCalls: [{ name: "mcp__ghost__vanish", arguments: {} }] }, { deltas: ["done"] }],
    });
    await injectSurface(rig.stub);
    const sent = await rig.stub.sendMessage({
      clientRequestId: "mcp-miss",
      content: [{ type: "text", text: "ghost call" }],
      mode: "start",
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const threadId = events[0]?.threadId;
    if (threadId === undefined) throw new Error("empty event list");
    const { result } = toolResultOf(events, threadId, "mcp__ghost__vanish");
    expect(result.data.status).toBe("error");
    expect(result.data.output).toContain("no live route for mcp__ghost__vanish");
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);
  });
});
