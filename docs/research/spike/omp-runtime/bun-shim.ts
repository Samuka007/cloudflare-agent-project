/**
 * Minimal Node-side shim for the `bun` module specifier, covering the runtime
 * API subset omp's tool-dependency closure actually reaches in the
 * read/glob/grep/write/edit family. Spike-grade: correct for these paths,
 * throws where the real Bun API would be required.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import YAMLParser from "yaml";

function toPath(path: string | URL): string {
	return typeof path === "string" ? path : fileURLToPath(path);
}

function jsoncParse(text: string): unknown {
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(stripped);
}

class ShimFile {
	constructor(private readonly path: string) {}
	get type(): string {
		const mime = {
			".json": "application/json",
			".md": "text/markdown",
			".ts": "text/typescript",
			".txt": "text/plain",
		}[nodePath.extname(this.path).toLowerCase()];
		return mime ?? "application/octet-stream";
	}
	get size(): number {
		return statSync(this.path).size;
	}
	async text(): Promise<string> {
		return readFile(this.path, "utf8");
	}
	async json(): Promise<unknown> {
		return JSON.parse(await readFile(this.path, "utf8"));
	}
	async arrayBuffer(): Promise<ArrayBuffer> {
		const buffer = await readFile(this.path);
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
	}
	async exists(): Promise<boolean> {
		return existsSync(this.path);
	}
}

/** Bun.write semantics: creates parent dirs, returns bytes written. */
async function bunWrite(path: string | URL, data: string | Uint8Array): Promise<number> {
	const target = toPath(path);
	await mkdir(nodePath.dirname(target), { recursive: true });
	const payload = typeof data === "string" ? data : Buffer.from(data);
	await writeFile(target, payload);
	return payload.byteLength;
}

class ShimGlob {
	async *scan(_pattern: string): AsyncGenerator<string> {
		throw new Error("bun-shim: Bun.Glob not implemented for spike");
	}
}

function bunSpawnSync(command: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { exitCode: 0, stdout, stderr: "" };
	} catch (error) {
		const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
		return {
			exitCode: err.status ?? 1,
			stdout: (err.stdout ?? Buffer.alloc(0)).toString(),
			stderr: (err.stderr ?? Buffer.alloc(0)).toString(),
		};
	}
}

const shimmed = {
	YAML: { parse: (text: string) => YAMLParser.parse(text), stringify: (value: unknown) => YAMLParser.stringify(value) },
	JSONC: { parse: jsoncParse },
	Glob: ShimGlob,
	Cookie: class {},
	CookieMap: class {},
	plugin: () => undefined,
	file: (path: string | URL) => new ShimFile(toPath(path)),
	write: bunWrite,
	spawnSync: bunSpawnSync,
	version: "1.3.14-node-shim",
};

export default shimmed;
export const { YAML, JSONC, Glob, Cookie, CookieMap, plugin, file, write, spawnSync } = shimmed;
