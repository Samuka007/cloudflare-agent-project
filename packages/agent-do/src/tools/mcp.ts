import { z } from "zod";
import {
  McpClient,
  StreamableHttpTransport,
  type CallToolResult,
  type McpFetch,
  type Tool,
} from "@cap/mcp/http";
import type { McpWireTool } from "../provider.js";

/**
 * DO-local MCP client integration (matrix C2, #327) — the edge port of the
 * pi/mcp client stack (`@cap/mcp`, vendored from @earendil-works/pi-mcp
 * 1.0.3 @ 98d2e1947aa9; docs/research/pi-parity-matrix.md §3.2 ranking 1,
 * E6 row).
 *
 * Edge class (classification table §2 — same verdict path as web_search,
 * M1.5 T12): the transport is Streamable HTTP executed inside this DO via
 * plain `fetch` — zero daemon touches, zero DO state beyond the tool.result
 * journal row (practice 11). pi's other transports do NOT route here: stdio
 * needs process semantics (daemon-side evaluation, matrix C2 "daemon stdio
 * 评估"), in-memory is a testing fixture.
 *
 * Port fidelity (pi anchors, coding-agent/src/extensions/mcp/):
 * - Tool naming: `mcp__<server>__<tool>` sanitized to [A-Za-z0-9_], 64-char
 *   cap with a deterministic hash suffix on overflow/collision
 *   (tools.ts:78-93 createMcpToolName). Deviation: the suffix hash is
 *   SHA-256 via WebCrypto (workerd has no sync node:crypto); the 8-hex
 *   slice and the `${name.slice}_` layout are pi verbatim.
 * - Input-schema normalization: object-guarantee + default `properties`
 *   (tools.ts:236-242 toParameters) — some providers reject schemas without
 *   them, and MCP servers may omit `type`.
 * - Output discipline: model-facing text capped at MCP_OUTPUT_MAX_BYTES
 *   (tools.ts:51, 20 KiB) with Codex-style middle truncation
 *   (tools.ts:124-145 limitMcpContent). Deviation: pi spills the full text
 *   to a session artifact file; the edge journal has no fs, so the
 *   truncation notice names the cap instead of a path.
 * - Server isolation: a server that fails to connect or list contributes
 *   NO tools this turn and the rest stay usable (runtime.ts:155 connect
 *   posture — a dead server never blocks the session); the next call
 *   re-discovers.
 * - Discovery cache: per-DO TTL cache (pi lists tools at session start;
 *   a DO lives across turns, so the TTL bounds staleness without a
 *   per-call round-trip).
 *
 * Deliberate reduction: resources/prompts/sampling/elicitation are outside
 * this ticket's surface — tools only (pi README "Supported protocol
 * surface" tool rows; the vendored package's own conformance suite covers
 * the protocol breadth).
 */

// ---------------------------------------------------------------------------
// Config — deployment-time env per the config.ts patch-over-defaults pattern
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  /** Namespace segment of the wire name (`mcp__<name>__<tool>`). */
  name: string;
  /** Streamable HTTP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string;
  /** Static headers (bearer tokens); OAuth is the vendored package's own
   * surface and is NOT wired in this ticket — unauthenticated servers plus
   * static credentials only. */
  headers?: Record<string, string>;
  /** Per-request ceiling in seconds (clamped 1..300 at decode; default 60 —
   * pi runtime.ts:48 DEFAULT_TIMEOUT_SECONDS). */
  timeoutSeconds: number;
}

export const DEFAULT_MCP_TIMEOUT_SECONDS = 60;
export const MAX_MCP_TIMEOUT_SECONDS = 300;

const mcpServerEntrySchema = z.object({
  name: z.string().min(1).max(64),
  url: z.url(),
  headers: z.record(z.string(), z.string().min(1)).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

const mcpServersSchema = z.array(mcpServerEntrySchema).max(16);

/**
 * Decode the `AGENT_DO_MCP_SERVERS` env JSON (an array of server entries).
 * Empty/absent = no MCP surface (the tool set is exactly as before this
 * module). Shape violations throw (zod) — a malformed deployment input must
 * fail the DO loudly, never silently shrink the surface (web_search L1
 * posture).
 */
export function decodeMcpServersConfig(raw: string | undefined): McpServerConfig[] {
  if (raw === undefined || raw === "") return [];
  const entries = mcpServersSchema.parse(JSON.parse(raw));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`mcp config: duplicate server name "${entry.name}"`);
    }
    seen.add(entry.name);
  }
  return entries.map((entry) => ({
    name: entry.name,
    url: entry.url,
    ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    timeoutSeconds: Math.min(
      MAX_MCP_TIMEOUT_SECONDS,
      Math.max(1, entry.timeoutSeconds ?? DEFAULT_MCP_TIMEOUT_SECONDS),
    ),
  }));
}

// ---------------------------------------------------------------------------
// Wire projection — pi tools.ts ports (naming, schema, annotations)
// ---------------------------------------------------------------------------

/** Model-facing projection of one discovered MCP tool (the type owner is
 * provider.ts — ModelRequest crosses the package boundary; re-exported here
 * for the executor's consumers). */
export type { McpWireTool };

/** The registry-name → (server, tool) route behind one wire name. */
export interface McpToolRoute {
  server: McpServerConfig;
  tool: string;
}

/** pi tools.ts:49 — provider tool names are limited to 64 chars. */
export const MAX_MCP_TOOL_NAME_LENGTH = 64;

/** 8-hex SHA-256 prefix (pi tools.ts:91) — WebCrypto for workerd parity. */
async function nameHash(server: string, tool: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${server}\0${tool}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when
 * too long (pi tools.ts:84-93 createMcpToolName): sanitizing can map two
 * tools to one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export async function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): Promise<string> {
  // pi tools.ts:89 — everything but [A-Za-z0-9_] becomes `_`.
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_MCP_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = await nameHash(server, tool);
  return `${name.slice(0, MAX_MCP_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * Tool input schemas must be objects; MCP servers may omit `type`, and some
 * providers reject object schemas without `properties` (pi tools.ts:236-242
 * toParameters verbatim, un-typed).
 */
export function toMcpInputParameters(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? "object",
    ...(schema.properties === undefined ? { properties: {} } : {}),
  };
}

// ---------------------------------------------------------------------------
// Output projection — pi tools.ts:124-145 limitMcpContent posture
// ---------------------------------------------------------------------------

/** pi tools.ts:51 MCP_OUTPUT_MAX_BYTES — model-facing text cap. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

/** Codex-style middle truncation (pi truncateMiddle shape, byte-counted). */
export function truncateMcpText(
  text: string,
  maxBytes: number = MCP_OUTPUT_MAX_BYTES,
): { content: string; truncated: boolean; totalBytes: number; totalLines: number } {
  const totalBytes = new TextEncoder().encode(text).byteLength;
  const totalLines = text.split("\n").length;
  if (totalBytes <= maxBytes) {
    return { content: text, truncated: false, totalBytes, totalLines };
  }
  let head = "";
  let tail = "";
  const chars = text.length;
  // Halve the character cut until the joined output fits the byte budget
  // (multi-byte content shrinks the effective cut below maxBytes/2 chars).
  for (let cut = Math.floor(chars / 2); cut > 0; cut = Math.floor(cut / 2)) {
    head = text.slice(0, cut);
    tail = text.slice(chars - cut);
    if (new TextEncoder().encode(`${head}\n…\n${tail}`).byteLength <= maxBytes) break;
  }
  const content = `${head}\n[…middle elided…]\n${tail}`;
  return { content, truncated: true, totalBytes, totalLines };
}

/**
 * Model-facing text of one CallToolResult: text blocks joined, non-text
 * blocks named (the edge tool.result journal is text-only), structured
 * content kept when the server sent no text (pi toModelContent posture minus
 * its image passthrough — ToolResultContribution.output is a string).
 */
export function projectMcpToolOutput(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      parts.push(`[resource link: ${block.uri}]`);
      continue;
    }
    if (block.type === "resource") {
      // Both content shapes (text/blob) carry the source uri.
      parts.push(`[resource: ${block.resource.uri}]`);
      continue;
    }
    if (block.type === "audio") {
      parts.push(`[audio: ${block.mimeType}]`);
      continue;
    }
    parts.push(`[image: ${block.mimeType}]`);
  }
  const text = parts.join("\n");
  if (text !== "" || result.structuredContent === undefined) return text;
  return JSON.stringify(result.structuredContent);
}

/** The truncated projection actually journaled as tool.result output. */
export function limitMcpOutput(text: string): string {
  const truncation = truncateMcpText(text);
  if (!truncation.truncated) return text;
  const tokens = Math.ceil(truncation.totalBytes / 4);
  return (
    `Warning: truncated output (original token count: ${tokens})\n` +
    `Total output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n` +
    `[Full output not retained: the edge journal carries only this truncated projection]`
  );
}

// ---------------------------------------------------------------------------
// Surface — per-server connection cache + TTL-cached discovery
// ---------------------------------------------------------------------------

export interface McpSurfaceDeps {
  /** Test seam; production uses global fetch (workerd outbound). */
  fetchImpl?: McpFetch;
  now?: () => number;
  /** Discovery cache TTL; default 60s. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
/** pi runtime.ts:51-52 — retry posture is per-use lazy reconnect; discovery
 * failures just shrink the surface for this turn, so no retry table here. */

const CLIENT_INFO = { name: "cloudflare-agent-project", version: "0.1.0" } as const;

interface CachedConnection {
  client: McpClient;
  close(): Promise<void>;
}

/**
 * The DO-bound MCP face: discovery → wire tools + routes, call → result.
 * One instance per DO (constructor); all caches are memory-only — a DO
 * eviction re-discovers, which is the recovery path, not a special case.
 */
export class McpToolSurface {
  private readonly connections = new Map<string, CachedConnection>();
  private cache:
    | {
        at: number;
        tools: McpWireTool[];
        routes: Map<string, McpToolRoute>;
      }
    | undefined;

  constructor(
    /** Empty = the module is inert (wireTools resolves [], routeOf undefined). */
    private readonly servers: readonly McpServerConfig[],
    private readonly deps: McpSurfaceDeps = {},
  ) {}

  /** True when any server is configured — the DO skips discovery entirely
   * otherwise (zero fetch, zero surface change). */
  get enabled(): boolean {
    return this.servers.length > 0;
  }

  /** The route behind a wire name, or undefined when the name is not a
   * live MCP route (dispatch falls through to the daemon path, whose
   * unknown-tool error is the fail-closed answer). */
  routeOf(wireName: string): McpToolRoute | undefined {
    return this.cache?.routes.get(wireName);
  }

  /**
   * Discover every configured server's tools (TTL-cached). A failing server
   * logs and contributes nothing — the remaining servers stay usable (pi
   * server-isolation posture). Routes are rebuilt atomically with the tools
   * so a wire name can never resolve against a stale server set.
   */
  async wireTools(): Promise<McpWireTool[]> {
    if (!this.enabled) return [];
    const now = (this.deps.now ?? Date.now)();
    if (this.cache !== undefined && now - this.cache.at < (this.deps.ttlMs ?? DEFAULT_TTL_MS)) {
      return this.cache.tools;
    }
    const tools: McpWireTool[] = [];
    const routes = new Map<string, McpToolRoute>();
    const isTaken = (name: string) => routes.has(name);
    for (const server of this.servers) {
      try {
        const client = await this.connection(server);
        const listed: Tool[] = await client.listTools({
          timeoutMs: server.timeoutSeconds * 1_000,
        });
        for (const tool of listed) {
          const wireName = await createMcpToolName(server.name, tool.name, isTaken);
          routes.set(wireName, { server, tool: tool.name });
          tools.push({
            name: wireName,
            description:
              tool.description ??
              `MCP tool \`${tool.name}\` from server \`${server.name}\` (no description provided).`,
            input_schema: toMcpInputParameters(tool.inputSchema),
          });
        }
      } catch (error) {
        // Server isolation: log, drop the poisoned connection, continue.
        console.error(`mcp: server "${server.name}" discovery failed; excluded this turn`, error);
        this.connections.delete(server.url);
      }
    }
    this.cache = { at: now, tools, routes };
    return tools;
  }

  /**
   * One tool call through the cached connection. A connection that died
   * since discovery (DO idle, server restart) reconnects once and retries
   * once — pi runtime.ts:155 "Reconnects lazily when a call finds the
   * connection gone".
   */
  async callTool(
    route: McpToolRoute,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    const deadlineMs = Math.min(
      route.server.timeoutSeconds * 1_000,
      ...(options.timeoutMs !== undefined ? [options.timeoutMs] : []),
    );
    let client = await this.connection(route.server);
    try {
      return await client.callTool(route.tool, args, {
        signal: options.signal,
        timeoutMs: deadlineMs,
      });
    } catch (error) {
      if (client.connectionState === "closed") {
        // The cached connection died between discovery and call: one
        // reconnect, one retry — never a second execution of a MAYBE-delivered
        // request (a request that reached the server before the drop resolves
        // through the retry's fresh session as a new call; MCP tools here are
        // read-shaped, and the retry-matrix's at-least-once frame is the DO
        // journal's, not the transport's).
        this.connections.delete(route.server.url);
        client = await this.connection(route.server);
        return await client.callTool(route.tool, args, {
          signal: options.signal,
          timeoutMs: deadlineMs,
        });
      }
      throw error;
    }
  }

  /** Connected (or connecting) client for one server, cached by URL. */
  private async connection(server: McpServerConfig): Promise<McpClient> {
    const cached = this.connections.get(server.url);
    if (cached?.client.connectionState === "connected") {
      return cached.client;
    }
    this.connections.delete(server.url);
    const client = new McpClient({ ...CLIENT_INFO });
    const transport = new StreamableHttpTransport({
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
      ...(this.deps.fetchImpl === undefined ? {} : { fetch: this.deps.fetchImpl }),
    });
    await client.connect(transport);
    const entry: CachedConnection = {
      client,
      close: () => client.close(),
    };
    this.connections.set(server.url, entry);
    return client;
  }
}
