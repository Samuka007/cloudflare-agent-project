/**
 * Adapter driver: exercises executeDispatch with real ToolDispatchRequest
 * frames — ok, error (unknown tool), isError propagation, and timeout paths.
 */
import { createToolHost, executeDispatch, type DispatchFrame } from "./omp-tool-adapter.ts";

const FIXTURE = "/tmp/omp-spike/fixture";
const MACHINE = "machine-spike-1";

const host = await createToolHost(FIXTURE, MACHINE);
console.log("host tools:", Object.keys(host.tools).join(", "));

const frames: DispatchFrame[] = [
  {
    tool: "glob",
    arguments: { pattern: "**/*.ts", path: FIXTURE },
    executionId: "t1-glob",
    machineId: MACHINE,
    timeoutMs: 10_000,
  },
  {
    tool: "read",
    arguments: { path: "src/alpha.ts" },
    executionId: "t2-read",
    machineId: MACHINE,
    timeoutMs: 10_000,
  },
  {
    tool: "grep",
    arguments: { pattern: "GrepNeedle", path: FIXTURE },
    executionId: "t3-grep",
    machineId: MACHINE,
    timeoutMs: 10_000,
  },
  {
    tool: "bash",
    arguments: { command: "echo hi" },
    executionId: "t4-unknown",
    machineId: MACHINE,
    timeoutMs: 5_000,
  },
  {
    tool: "read",
    arguments: { path: "no/such/file.txt" },
    executionId: "t5-missing",
    machineId: MACHINE,
    timeoutMs: 5_000,
  },
  {
    tool: "read",
    arguments: { path: "src/alpha.ts" },
    executionId: "t6-timeout",
    machineId: MACHINE,
    timeoutMs: 1,
  },
  {
    tool: "read",
    arguments: { path: "src/alpha.ts" },
    executionId: "t7-wrong-machine",
    machineId: "machine-other",
    timeoutMs: 5_000,
  },
];

for (const frame of frames) {
  const started = performance.now();
  const result = await executeDispatch(host, frame);
  const ms = (performance.now() - started).toFixed(0);
  console.log(
    `\n[${frame.executionId}] ${frame.tool} → ${result.status} (${ms}ms) truncated=${result.outputTruncated ?? false}`,
  );
  console.log(`  output: ${result.output.slice(0, 160).replace(/\n/g, " ⏎ ")}`);
}
