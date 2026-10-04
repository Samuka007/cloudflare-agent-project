/**
 * Spike adapter: daemon dispatch frame {tool, arguments, executionId,
 * machineId, timeoutMs} → omp AgentTool.execute(); omp AgentToolResult →
 * our ToolResultPayload. Host construction included — this is the whole
 * Node/Bun-side surface needed to serve host-class M1.5 tools.
 */
import { Settings } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/config/settings.ts";
import { EditTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/edit/index.ts";
import { GlobTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/glob.ts";
import { GrepTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/grep.ts";
import { ReadTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/read.ts";
import { WriteTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/write.ts";

interface OmpLikeTool {
	name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: (partial: { content: { type: string; text?: string }[] }) => void,
	): Promise<OmpToolResult>;
}

interface OmpToolResult {
	content: { type: string; text?: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

export interface DispatchFrame {
	tool: string;
	arguments: Record<string, unknown>;
	executionId: string;
	machineId: string;
	timeoutMs: number;
}

export type WireStatus = "ok" | "error" | "timeout";

export interface ToolResultPayload {
	status: WireStatus;
	exitCode: null;
	output: string;
	outputTruncated?: boolean;
}

export interface ToolHost {
	/** machineId this host is bound to (frame.machineId must match). */
	machineId: string;
	settings: Settings;
	session: Record<string, unknown>;
	tools: Record<string, OmpLikeTool>;
}

export async function createToolHost(cwd: string, machineId: string): Promise<ToolHost> {
	const settings = await Settings.loadIsolated({ cwd });
	const session = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as never;
	const candidates: OmpLikeTool[] = [
		new GlobTool(session),
		new GrepTool(session),
		new ReadTool(session),
		new WriteTool(session),
		new EditTool(session) as unknown as OmpLikeTool,
	];
	const tools: Record<string, OmpLikeTool> = {};
	for (const tool of candidates) tools[tool.name] = tool;
	return { machineId, settings, session, tools };
}

export async function executeDispatch(
	host: ToolHost,
	frame: DispatchFrame,
	onOutput?: (chunk: string) => void,
): Promise<ToolResultPayload> {
	if (frame.machineId !== host.machineId) {
		return { status: "error", exitCode: null, output: `frame for machine ${frame.machineId} reached host ${host.machineId}` };
	}
	const tool = host.tools[frame.tool];
	if (!tool) {
		return { status: "error", exitCode: null, output: `unknown tool: ${frame.tool}` };
	}
	const controller = new AbortController();
	const timedOut = { value: false };
	const timer = frame.timeoutMs > 0
		? setTimeout(() => {
				timedOut.value = true;
				controller.abort(new Error(`timeout after ${frame.timeoutMs}ms`));
			}, frame.timeoutMs)
		: undefined;
	try {
		const result = await tool.execute(
			frame.executionId,
			frame.arguments,
			controller.signal,
			onOutput
				? partial =>
						onOutput(partial.content.map(block => (block.type === "text" ? (block.text ?? "") : `<${block.type}>`)).join("\n"))
				: undefined,
		);
		const output = result.content.map(block => (block.type === "text" ? (block.text ?? "") : `<${block.type}>`)).join("\n");
		const truncation = (result.details?.meta as { truncation?: unknown } | undefined)?.truncation;
		return {
			status: result.isError ? "error" : "ok",
			exitCode: null,
			output,
			outputTruncated: truncation !== undefined,
		};
	} catch (error) {
		if (timedOut.value && error instanceof Error && error.name === "AbortError") {
			return { status: "timeout", exitCode: null, output: `timeout after ${frame.timeoutMs}ms` };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { status: "error", exitCode: null, output: message };
	} finally {
		clearTimeout(timer);
	}
}
