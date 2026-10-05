/**
 * Fetch-side surface (`@cap/mcp/http`): the client, the Streamable HTTP
 * transport, and the shared protocol types — WITHOUT the Node transports.
 *
 * Why this entry exists (#327): the package root re-exports
 * `StdioTransport`, which imports `node:child_process`; any Workers-typed
 * program that compiles the root (e.g. apps/provider-app via
 * @cap/agent-do) would pull @types/node's globals into its ambient set and
 * flip `setTimeout` from `number` to `NodeJS.Timeout`. The edge integration
 * (@cap/agent-do tools/mcp.ts) imports from here; the full root entry
 * stays for Node/Bun consumers (the daemon side, the conformance suite).
 */
export type { AuthProvider, McpFetch, UnauthorizedContext } from "./auth-provider.ts";
export { McpClient, type McpClientOptions, type McpRequestOptions } from "./client.ts";
export {
	type AudioContent,
	type BlobResourceContents,
	type CallToolResult,
	type ContentAnnotations,
	type ContentBlock,
	type EmbeddedResourceContent,
	type ImageContent,
	type LlmContent,
	type ResourceLinkContent,
	type TextContent,
	type TextResourceContents,
	toLlmContent,
} from "./protocol/content.ts";
export {
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcErrorObject,
	type JsonRpcErrorResponse,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type JsonRpcSuccessResponse,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	parseJsonRpcMessage,
} from "./protocol/jsonrpc.ts";
export {
	type CancelledNotification,
	type ClientCapabilities,
	type Implementation,
	type InitializeParams,
	type InitializeResult,
	LATEST_PROTOCOL_VERSION,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type ListToolsResult,
	type ProgressNotification,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	type Root,
	type ServerCapabilities,
	SUPPORTED_PROTOCOL_VERSIONS,
	type SupportedProtocolVersion,
	type Tool,
	type ToolAnnotations,
	type ToolExecution,
} from "./protocol/types.ts";
export {
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
	StreamableHttpTransport,
	type StreamableHttpReconnectOptions,
	type StreamableHttpTransportOptions,
} from "./transports/streamable-http.ts";
export type {
	McpTransport,
	McpTransportCloseListener,
	McpTransportErrorListener,
	McpTransportMessageListener,
} from "./transports/transport.ts";
