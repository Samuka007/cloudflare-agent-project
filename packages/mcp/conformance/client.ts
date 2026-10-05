/**
 * Client under test for the official MCP client conformance suite (#327). The suite starts a
 * scenario server and runs this script with the server URL as the last argument, the scenario name
 * in `MCP_CONFORMANCE_SCENARIO`, and scenario data in `MCP_CONFORMANCE_CONTEXT`.
 *
 * It drives the @cap/mcp primitives directly — `McpClient` over
 * `StreamableHttpTransport` with an `McpOAuthProvider` credential store —
 * which is the same stack the edge integration (@cap/agent-do tools/mcp.ts)
 * executes in production. The browser is simulated: the authorization URL is
 * fetched without following its redirect, and the redirect is delivered to
 * the loopback callback server. Credentials stay in memory.
 *
 * Structure and scenario mapping follow upstream
 * `packages/coding-agent/test/mcp-conformance/client.ts` (pi @ 98d2e1947aa9);
 * the pi-side `McpServerConnection`/`signInMcpServer` orchestration is
 * re-expressed over the package's own OAuth exports (conformance is the
 * package's gate, not the coding-agent integration's).
 *
 * Run through run.ts, which writes the outcome to `CAP_MCP_CONFORMANCE_REPORT`.
 */

import { writeFileSync } from "node:fs";
import {
  McpAuthRequiredError,
  McpClient,
  StreamableHttpTransport,
  type CallToolResult,
  type Tool,
} from "../src/index.ts";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  MemoryOAuthStateStore,
  OAuthCallbackServer,
  authorizeMcp,
  parseWwwAuthenticate,
  stepUpScope,
  type OAuthChallenge,
} from "../src/oauth/index.ts";

/**
 * Sign-ins the client asks for are not limited, so a client who keeps approving them would loop
 * forever against a server that never accepts the granted scope. This simulated user gives up after
 * three, the limit `auth/scope-retry-limit` checks.
 */
const MAX_SIGN_INS = 3;
const REQUEST_TIMEOUT_SECONDS = 20;

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool calls of a scenario after connecting. `undefined` for scenarios this client does not know. */
function toolCalls(scenario: string, connection: ConformanceConnection): ToolCall[] | undefined {
  if (scenario.startsWith("auth/")) return [{ name: "test-tool", arguments: {} }];
  switch (scenario) {
    case "initialize":
      return [];
    case "tools_call":
      return [{ name: "add_numbers", arguments: { a: 2, b: 3 } }];
    case "sse-retry":
      return [{ name: "test_reconnection", arguments: {} }];
    case "elicitation-sep1034-client-defaults":
      return [{ name: "test_client_elicitation_defaults", arguments: {} }];
    case "json-schema-2020-12-preservation": {
      // The server compares the echoed schema with the one it listed, to detect dropped keywords.
      const tool = connection.tools.find(
        (candidate) => candidate.name === "json_schema_2020_12_tool",
      );
      if (!tool) throw new Error("json_schema_2020_12_tool was not listed");
      return [{ name: "json_schema_echo", arguments: { schema: tool.inputSchema } }];
    }
    default:
      return undefined;
  }
}

function log(message: string): void {
  process.stderr.write(`[cap-conformance] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readContext(): Record<string, unknown> {
  const raw = process.env.MCP_CONFORMANCE_CONTEXT;
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP_CONFORMANCE_CONTEXT is not an object");
  }
  return parsed as Record<string, unknown>;
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** What a browser does with the authorization URL when the user approves at once. */
async function visitAuthorizationUrl(url: URL): Promise<void> {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location)
    throw new Error(`Authorization endpoint answered ${response.status} without a redirect`);
  const callback = new URL(location, url);
  if (callback.protocol !== "http:" || !isLoopback(callback)) {
    throw new Error(
      `Authorization endpoint redirected to ${callback.origin}, not to the loopback callback`,
    );
  }
  log(`delivering authorization response to ${callback.origin}${callback.pathname}`);
  await (await fetch(callback)).text();
}

interface SignInPrompt {
  showAuthorizationUrl(url: URL): void;
  promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

function simulatedBrowser(): SignInPrompt {
  let visit: Promise<void> | undefined;
  return {
    showAuthorizationUrl(url) {
      log(`authorization URL: ${url.origin}${url.pathname}`);
      visit = visitAuthorizationUrl(url);
    },
    async promptForRedirectUrl(signal) {
      try {
        await visit;
      } catch (error) {
        // Cancels the sign-in instead of waiting for a callback that never comes.
        log(`browser failed: ${errorMessage(error)}`);
        return undefined;
      }
      if (!signal.aborted) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        signal.addEventListener("abort", resolve, { once: true });
        await promise;
      }
      return undefined;
    },
  };
}

/**
 * The conformance face of an HTTP MCP server: connect (401 → `needs-auth`),
 * list tools, call tools, and the OAuth sign-in loop — `McpOAuthProvider` +
 * `OAuthCallbackServer` + `authorizeMcp`, with the last challenge feeding
 * resource-metadata and scope (step-up) into the next attempt.
 */
class ConformanceConnection {
  state: "connecting" | "connected" | "needs-auth" | "closed" = "connecting";
  /** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
  challenge: OAuthChallenge | undefined;
  tools: Tool[] = [];

  private client: McpClient | undefined;
  private readonly store = new MemoryOAuthStateStore();

  constructor(
    readonly serverUrl: string,
    private readonly options: { clientId?: string; clientSecret?: string },
  ) {}

  private provider(redirectUrl: string, onRedirect: (url: URL) => void): McpOAuthProvider {
    return new McpOAuthProvider({
      serverUrl: this.serverUrl,
      redirectUrl,
      clientMetadata: { client_name: "cap-mcp-conformance" },
      ...(this.options.clientId === undefined
        ? {}
        : {
            clientId: this.options.clientId,
            ...(this.options.clientSecret === undefined
              ? {}
              : { clientSecret: this.options.clientSecret }),
          }),
      store: this.store,
      onRedirect,
    });
  }

  /** Connect and list tools; a 401/insufficient-scope challenge marks `needs-auth`. */
  async connect(): Promise<void> {
    this.state = "connecting";
    // A reconnect after sign-in replaces the previous connection: close it so
    // its GET stream does not linger for the rest of the scenario.
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    const client = new McpClient({
      name: "cap-mcp-conformance",
      version: "0.1.0",
      requestTimeoutMs: REQUEST_TIMEOUT_SECONDS * 1_000,
    });
    const transport = new StreamableHttpTransport({
      url: this.serverUrl,
      authProvider: {
        token: () => Promise.resolve(this.store.load()?.tokens?.access_token),
        onUnauthorized: (context) => {
          const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
          // The suite's auth scenarios ask for fresh sign-ins (pre-registered
          // clients, missing grants, step-up scope) — no refresh dance, the
          // sign-in loop owns every 401.
          this.challenge = challenge;
          return Promise.reject(new McpOAuthAuthorizationRequiredError());
        },
      },
    });
    try {
      await client.connect(transport);
      this.tools = await client.listTools({ timeoutMs: REQUEST_TIMEOUT_SECONDS * 1_000 });
      this.client = client;
      this.state = "connected";
    } catch (error) {
      await client.close().catch(() => undefined);
      // The transport surfaces a 401 challenge either as McpAuthRequiredError
      // (no provider answer) or as the provider's McpOAuthAuthorizationRequiredError
      // (the challenge was captured into `this.challenge` first) — at connect
      // OR at the post-connect tools/list — both mean the sign-in loop owns
      // the next move.
      this.state =
        error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError
          ? "needs-auth"
          : "closed";
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = this.client;
    if (client === undefined) throw new Error("not connected");
    try {
      return await client.callTool(name, args, { timeoutMs: REQUEST_TIMEOUT_SECONDS * 1_000 });
    } catch (error) {
      // A mid-call 401/insufficient-scope challenge: the provider captured the
      // challenge into `this.challenge`; the sign-in loop owns the next move
      // (pi runtime.ts:314-317 needsSignIn → markNeedsAuth posture).
      if (
        error instanceof McpOAuthAuthorizationRequiredError ||
        error instanceof McpAuthRequiredError
      ) {
        this.state = "needs-auth";
      }
      throw error;
    }
  }

  /** One OAuth sign-in (PKCE + dynamic registration by default), browser simulated. */
  async signIn(): Promise<void> {
    const challenge = this.challenge;
    const callback = await OAuthCallbackServer.listen({ port: 0 });
    try {
      let authorizationUrl: URL | undefined;
      const provider = this.provider(callback.redirectUrl, (url) => {
        authorizationUrl = url;
      });
      const stepUp = challenge?.error === "insufficient_scope";
      const stored = this.store.load();
      // A server asking for more scope gets it on top of the scope granted so far.
      const challengeScope = challenge?.scope;
      const scope = stepUp ? stepUpScope(stored?.tokens?.scope, challengeScope) : challengeScope;
      const flow = {
        serverUrl: this.serverUrl,
        resourceMetadataUrl: challenge?.resourceMetadataUrl,
        ...(scope === undefined ? {} : { scope }),
        // A refresh keeps the granted scope; a step-up needs the browser flow.
        ...(stepUp ? { skipRefresh: true } : {}),
      };
      if ((await authorizeMcp(provider, flow)) === "AUTHORIZED") return;
      if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");
      const state = await provider.state();
      const prompt = simulatedBrowser();
      prompt.showAuthorizationUrl(authorizationUrl);
      const { code, iss } = await callback.waitForCallback(state);
      await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
    } finally {
      await callback.close();
    }
  }

  async close(): Promise<void> {
    this.state = "closed";
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}

async function run(serverUrl: string, scenario: string): Promise<void> {
  const context = readContext();
  const options =
    typeof context.client_id === "string"
      ? {
          clientId: context.client_id,
          ...(typeof context.client_secret === "string"
            ? { clientSecret: context.client_secret }
            : {}),
        }
      : {};
  const connection = new ConformanceConnection(serverUrl, options);

  let signIns = 0;
  /** Run `operation`, signing in like a user answering a 401 whenever the server asks for it. */
  const withSignIn = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (connection.state !== "needs-auth") throw error;
        if (signIns >= MAX_SIGN_INS)
          throw new Error(`Still requires sign-in after ${signIns} sign-ins`);
        signIns++;
        log(
          `sign-in ${signIns}${connection.challenge?.scope ? ` (scope: ${connection.challenge.scope})` : ""}`,
        );
        await connection.signIn();
        await connection.connect();
      }
    }
  };

  try {
    await withSignIn(() => connection.connect());
    log(`connected, tools: ${connection.tools.map((tool) => tool.name).join(", ") || "(none)"}`);
    const calls = toolCalls(scenario, connection);
    if (!calls) throw new Error(`Unknown scenario ${scenario}`);
    for (const call of calls) {
      const result = await withSignIn(() => connection.callTool(call.name, call.arguments));
      log(`${call.name}: ${JSON.stringify(result.content)}`);
      if (result.isError)
        throw new Error(`Tool ${call.name} failed: ${JSON.stringify(result.content)}`);
    }
  } finally {
    await connection.close();
  }
}

async function main(): Promise<number> {
  const serverUrl = process.argv.at(-1);
  const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
  const reportPath = process.env.CAP_MCP_CONFORMANCE_REPORT;
  let report: { success: boolean; error?: string };
  if (!serverUrl || !scenario || process.argv.length < 3) {
    report = {
      success: false,
      error: "Usage: MCP_CONFORMANCE_SCENARIO=<scenario> client.ts <server-url>",
    };
  } else {
    try {
      await run(serverUrl, scenario);
      report = { success: true };
    } catch (error) {
      report = { success: false, error: errorMessage(error) };
    }
  }
  if (report.error) log(`error: ${report.error}`);
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report.success ? 0 : 1;
}

// Exit explicitly: a failed scenario can leave sockets of the server under test open.
process.exit(await main());
