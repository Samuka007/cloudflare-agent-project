import { toolRegistryRow } from "./registry.js";

/**
 * #289 host:path parameter-level override (control-plane-layer.md §2.2, gap
 * inventory #282 §2.B B1–B5).
 *
 * Semantics (§2.2 ruling): a path-bearing tool argument may carry
 * `ssh://<machineId>/<path>` — "THIS ONE call executes on another machine".
 * The override never rewrites the thread binding: the AgentDO switches the
 * single dispatch's machineId to the target, journals the deviation on the
 * `tool.dispatch` row (`overriddenMachineId`), and the next dispatch
 * resolves the bound machine again. Unroutable targets fail explicitly
 * (`unknown_host` / `exec_tier_required` / `host_offline`) — never a silent
 * fallback to the bound machine (静默换 host 红线, §2.2 last clause).
 *
 * omp anchor (two-source map §2.2/§2.3): any path parameter may carry the
 * internal URL and the router resolves it process-globally. One deliberate
 * divergence — omp splits tools by approval-UI topology (read/grep/write/
 * bash ride exec-tier approval; glob/ast_grep/ast_edit hard-reject ssh://
 * before connect because they bypass the gate, ssh-url-ungated-tools.test).
 * This system has no per-tool approval UI: the exec-tier grant is the
 * TARGET HOST's permission ceiling (hosts.max_permission_mode = "full",
 * the host row's 操作上限), checked by the AgentDO before any dispatch
 * leaves the DO (B4「连接前硬拒」— the rejection precedes the remote DO
 * stub). The omp safety contract — "a read/write-tier tool never connects
 * for an ssh:// path without the exec grant" — therefore holds uniformly
 * for every tool by construction, and every path-bearing host tool may
 * carry the override (inventory B1「任意 path 参数」).
 *
 * Grammar: `ssh://<machineId>/<path>` — the machineId is a bare registry id
 * (`[A-Za-z0-9][A-Za-z0-9._-]*`). omp's `user@`/`:port` destination escapes
 * are explicitly rejected here: this system has no OpenSSH transport — the
 * override target is a registered machine identity, not an ssh destination.
 * The path part is kept verbatim after the host (read selectors like
 * `:10-20` survive; `ssh://host:2222/x` is a parse error, not a port). An
 * absolute stripped path keeps each tool's own resolution discipline on the
 * target (host tools read absolute target paths; the bash sandbox clamp
 * still refuses absolute cwd escapes on the target too — no silent
 * relocation into the sandbox).
 *
 * bash cwd (B5, unified semantics): the per-call `cwd?` escape hatch joins
 * the same grammar — `cwd: "ssh://host/sub"` dispatches the bash call to
 * the target with `cwd: "sub"`, which the target resolves against ITS
 * workspace root exactly like a local call (client prepareBashFrame clamp +
 * executor resolveCwd). The daemon client needs no change: the unification
 * lives in this shared resolver at the routing layer.
 *
 * Pure and deterministic by contract: a watchdog re-ask re-runs the
 * resolution over the same journaled `tool.call` arguments and must land on
 * the same target with the same rewrite (the service journal dedups by
 * executionId — I16).
 */

/** Path-bearing host-class tools: the field this tool routes on, and
 * whether the field is `;`-separated (glob/grep multi-path convention). */
const PATH_FIELD_BY_TOOL: Record<string, { field: string; segmented: boolean }> = {
  read: { field: "path", segmented: false },
  write: { field: "path", segmented: false },
  find: { field: "path", segmented: false },
  glob: { field: "path", segmented: true },
  grep: { field: "path", segmented: true },
  bash: { field: "cwd", segmented: false },
};

/** edit carries paths embedded in the hashline `input` (`[PATH#TAG]`). The
 * tag snapshot belongs to whichever host produced it, so a cross-host edit
 * is resolved per host like any other tool — same machineId, whole call. */
const EDIT_TOOL = "edit";

/** Matches one ssh:// override URL inside a larger string (edit input scan);
 * the URL body ends at whitespace, `#` (tag separator), `]`, or `[`. */
const SSH_URL_SCAN_PATTERN = /ssh:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/[^\s#[\]]*)?/g;

export interface HostPathOverride {
  /** The machine this single dispatch rides (`tool.dispatch` deviation). */
  machineId: string;
  /** The call arguments with every ssh:// prefix rewritten to the path part. */
  arguments: Record<string, unknown>;
}

export type HostPathResolution = HostPathOverride | { error: string } | null;

/**
 * Parses one `ssh://` override URL. Returns null when the value is not an
 * override (any non-ssh:// string), `{ error }` for malformed overrides,
 * and the target + path part otherwise.
 */
export function parseSshOverrideUrl(
  value: string,
): { machineId: string; path: string } | { error: string } | null {
  if (!value.startsWith("ssh://")) return null;
  const body = value.slice("ssh://".length);
  if (body.length === 0) {
    return { error: `ssh:// override needs a machine id: "${value}"` };
  }
  const slash = body.indexOf("/");
  const authority = slash === -1 ? body : body.slice(0, slash);
  const path = slash === -1 ? "" : body.slice(slash); // keeps the leading "/"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(authority)) {
    return {
      error:
        `ssh:// override machine id must be a bare registry id ` +
        `(no user@/):port — omp destination escapes have no transport here): "${authority}"`,
    };
  }
  if (path === "") {
    return {
      error:
        `ssh:// override needs a path (bare ssh:// lists hosts in omp, ` +
        `but a path argument must name one): "${value}"`,
    };
  }
  return { machineId: authority, path };
}

/** Resolves one path field value; returns the rewritten value or an error. */
function resolveFieldValue(
  value: string,
  segmented: boolean,
): { value: string; machineId: string } | { error: string } | null {
  if (!segmented) {
    const parsed = parseSshOverrideUrl(value);
    if (parsed === null) return null;
    if ("error" in parsed) return parsed;
    return { value: parsed.path, machineId: parsed.machineId };
  }
  // glob/grep: `;`-separated paths (omp verbatim docs). Every ssh://
  // segment must name the SAME machine — one dispatch, one machine; a
  // mixed-host call would need per-segment routing this ticket does not
  // build (explicit error, never a silent split).
  const segments = value.split(";");
  let machineId: string | null = null;
  let sawOverride = false;
  const rewritten: string[] = [];
  for (const segment of segments) {
    const parsed = parseSshOverrideUrl(segment);
    if (parsed === null) {
      rewritten.push(segment);
      continue;
    }
    if ("error" in parsed) return parsed;
    if (machineId !== null && machineId !== parsed.machineId) {
      return {
        error:
          `ssh:// override segments must name one machine ` +
          `(${machineId} vs ${parsed.machineId}): "${value}"`,
      };
    }
    machineId = parsed.machineId;
    sawOverride = true;
    rewritten.push(parsed.path);
  }
  if (!sawOverride || machineId === null) return null;
  return { value: rewritten.join(";"), machineId };
}

/** Resolves the edit `input` scan: every ssh:// URL must name one machine. */
function resolveEditInput(
  input: string,
): { value: string; machineId: string } | { error: string } | null {
  SSH_URL_SCAN_PATTERN.lastIndex = 0;
  let machineId: string | null = null;
  const rewrites: { from: string; to: string }[] = [];
  for (;;) {
    const match = SSH_URL_SCAN_PATTERN.exec(input);
    if (match === null) break;
    const [url, rawAuthority, rawPath] = match;
    if (rawAuthority === undefined) {
      return { error: `ssh:// override needs a machine id: "${url}"` };
    }
    const authority = rawAuthority;
    if (machineId !== null && machineId !== authority) {
      return {
        error:
          `ssh:// override paths in one edit must name one machine ` +
          `(${machineId} vs ${authority})`,
      };
    }
    machineId = authority;
    if (rawPath === undefined) {
      return { error: `ssh:// override needs a path: "${url}"` };
    }
    rewrites.push({ from: url, to: rawPath });
  }
  if (machineId === null) return null;
  let value = input;
  for (const { from, to } of rewrites) {
    value = value.replace(from, to);
  }
  return { value, machineId };
}

/**
 * Resolves the host:path parameter-level override for one tool call.
 * Returns null when the call carries no override (the dispatch stays on the
 * bound machine, arguments untouched), `{ error }` for an override that
 * must fail before any dispatch (the caller ingests a structured error
 * result — no `tool.dispatch` row, mirroring the in-DO URI-read precedent),
 * and the target + rewritten arguments otherwise.
 */
export function resolveHostPathOverride(
  tool: string,
  args: Record<string, unknown>,
): HostPathResolution {
  // Only host-class (daemon-dispatch) tools cross a machine boundary; edge
  // tools execute in the DO mesh and hybrid control halves never route on
  // a filesystem path.
  if (toolRegistryRow(tool)?.backend.kind !== "daemon-dispatch") return null;

  if (tool === EDIT_TOOL) {
    const input = args.input;
    if (typeof input !== "string") return null;
    const resolved = resolveEditInput(input);
    if (resolved === null) return null;
    if ("error" in resolved) return resolved;
    return {
      machineId: resolved.machineId,
      arguments: { ...args, input: resolved.value },
    };
  }

  const fieldSpec = PATH_FIELD_BY_TOOL[tool];
  if (fieldSpec === undefined) return null;
  const raw = args[fieldSpec.field];
  if (typeof raw !== "string" || raw.length === 0) return null;
  const resolved = resolveFieldValue(raw, fieldSpec.segmented);
  if (resolved === null) return null;
  if ("error" in resolved) return resolved;
  return {
    machineId: resolved.machineId,
    arguments: { ...args, [fieldSpec.field]: resolved.value },
  };
}
