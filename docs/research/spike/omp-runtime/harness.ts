/**
 * omp-runtime-embedding spike harness (Q1/Q2).
 * Imports omp tool classes straight from checkout source, builds a minimal
 * ToolSession, and executes glob/grep/read/write/edit through omp's own
 * execute() path. Run with: bun harness.ts  OR  node --import tsx harness.ts
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { EditTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/edit/index.ts";
import { Settings } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/config/settings.ts";
import { GlobTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/glob.ts";
import { GrepTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/grep.ts";
import { ReadTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/read.ts";
import { WriteTool } from "/home/nixos/workspace/oh-my-pi/packages/coding-agent/src/tools/write.ts";
// Absolute specifier: /tmp has no node_modules path to the omp workspace;
// a bare specifier here would auto-install a cache copy without binaries.
import * as natives from "/home/nixos/workspace/oh-my-pi/packages/natives/native/index.js";

const FIXTURE = "/tmp/omp-spike/fixture";

interface ToolResult {
	content: { type: string; text?: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

interface ToolLike {
	name: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<ToolResult>;
}

interface ToolResultSummary {
	isError: boolean;
	contentChars: number;
	contentHead: string;
	detailsKeys?: string[];
	detailsMeta?: unknown;
}

function truncate(text: string, cap: number): string {
	return text.length <= cap ? text : `${text.slice(0, cap)}…<+${text.length - cap} chars>`;
}

function summarize(toolName: string, started: number, result: ToolResult): void {
	const text = result.content.map(block => (block.type === "text" ? (block.text ?? "") : `<${block.type}>`)).join("\n");
	const summary: ToolResultSummary = {
		isError: result.isError ?? false,
		contentChars: text.length,
		contentHead: truncate(text, 400),
		detailsKeys: result.details && typeof result.details === "object" ? Object.keys(result.details) : undefined,
		detailsMeta: result.details?.meta,
	};
	console.log(`\n=== ${toolName} OK (${(performance.now() - started).toFixed(0)}ms) ===`);
	console.log(JSON.stringify(summary, null, 2));
}

function summarizeThrow(toolName: string, started: number, error: unknown): void {
	const err = error as Error;
	console.log(`\n=== ${toolName} THREW (${(performance.now() - started).toFixed(0)}ms) ===`);
	console.log(`${err.name}: ${truncate(err.message, 600)}`);
}

async function runTool(label: string, tool: ToolLike, params: unknown): Promise<void> {
	const started = performance.now();
	try {
		const result = await tool.execute(`call-${tool.name}-1`, params, new AbortController().signal);
		summarize(label, started, result);
	} catch (error) {
		summarizeThrow(label, started, error);
	}
}

const settings = await Settings.loadIsolated({ cwd: FIXTURE });
// Minimal ToolSession: only cwd/hasUI/settings — structurally partial by design
// for the spike; the `never` bridge records that the full interface is NOT met.
const session = {
	cwd: FIXTURE,
	hasUI: false,
	settings,
	// The interface's two non-optional methods; tools read them for session
	// bookkeeping that a headless embedder legitimately has none of.
	getSessionFile: () => null,
	getSessionSpawns: () => null,
} as never;

const glob = new GlobTool(session);
const grep = new GrepTool(session);
const read = new ReadTool(session);
const write = new WriteTool(session);
const edit = new EditTool(session);
const tools: ToolLike[] = [glob, grep, read, write, edit as unknown as ToolLike];

console.log("harness runtime:", typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`);
console.log("pi-natives exports glob:", typeof natives.glob, "grep:", typeof natives.grep, "EditStore:", typeof natives.EditStore);
for (const tool of tools) {
	const schemaBytes = String(JSON.stringify(tool.parameters)?.length ?? "undefined");
	console.log(`tool ${tool.name}: schema=${schemaBytes}B desc=${(tool.description ?? "").length}B`);
}

await rm(path.join(FIXTURE, "harness-out"), { recursive: true, force: true });
await mkdir(path.join(FIXTURE, "harness-out"), { recursive: true });
await writeFile(
	path.join(FIXTURE, "src", "alpha.ts"),
	"Hello from fixture file alpha.\nLine two for selector tests.\nconst value = 42;\nexport function alpha() {\n  return \"alpha-result\";\n}\nLine seven.\nGrepNeedle present here.\n",
);

await runTool("glob **/*.ts", glob as ToolLike, { pattern: "**/*.ts", path: FIXTURE });
await runTool("grep GrepNeedle", grep as ToolLike, { pattern: "GrepNeedle", path: FIXTURE });
await runTool("read src/alpha.ts :2-5", read as ToolLike, { path: "src/alpha.ts:2-5" });
await runTool("write harness-out/draft.md", write as ToolLike, {
	path: "harness-out/draft.md",
	content: "# harness draft\nembedded write via omp WriteTool\n",
});
await runTool("edit apply_patch alpha.ts", edit as unknown as ToolLike, {
	input: [
		"*** Begin Patch",
		"*** Update File: src/alpha.ts",
		"@@",
		"-Line seven.",
		"+Line seven edited by omp EditTool.",
		"*** End Patch",
	].join("\n"),
});

console.log("\nfixture alpha.ts after edit:");
console.log(await readFile(path.join(FIXTURE, "src/alpha.ts"), "utf8"));
