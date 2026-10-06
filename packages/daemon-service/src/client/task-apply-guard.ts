import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * task-apply landing guard (#419) — the two mechanical failure classes of the
 * 2026-10-06 five-lane landing outage (#391/#393/#392 gitlink 0-file fake
 * conflicts; #398/#399 sidecar-collision "patch does not apply"), decoded and
 * handled at the daemon's isolation-release seam:
 *
 * 1. **Landing precheck** — a lane workspace spills tool-output sidecars
 *    (read-selector artifacts like `core.ts:conflicts`, the #418 residue
 *    class) and any untracked file NOT covered by .gitignore enters the
 *    captured delta (omp captureDeltaPatch includes untracked files,
 *    worktree.ts:96-109/162-192). Landing an add whose path the target tree
 *    already tracks fails `git apply` with the opaque "already exists" →
 *    "patch does not apply". The precheck decodes the cause BEFORE applying
 *    and refuses with the exact cleanup actions; a tracked `*:conflicts`
 *    residue in the TARGET tree refuses too (every lane reading that file
 *    spills a colliding add — the wave-wide #418 mechanism).
 *
 * 2. **Gitlink fake-conflict resolution** — cherry-picking a task branch
 *    whose range bumps a submodule pin onto a HEAD whose pin already moved
 *    past it reports "merge conflict in 0 file(s)": git's merge machinery
 *    does no ancestor analysis for gitlink entries (merge-ort resolves file
 *    contents only). When the two pins ARE ordered in the submodule's commit
 *    graph, the descendant pointer is the correct resolution (it contains
 *    the ancestor commit) — the retry engine lands it with zero manual
 *    steps and only reports a conflict when the pins are genuinely
 *    divergent or unverifiable.
 *
 * Guarded submodule access (trap 2 of #419): `git -C <path>` inside a
 * checkout whose submodule directory lacks `.git` climbs to the PARENT
 * repo's config and answers parent-repo truth — the mechanism behind the
 * 2026-10-06 origin-drift incident. Every submodule git call here first
 * verifies `<path>/.git` exists; absent ⇒ unresolvable, never a parent-repo
 * answer.
 *
 * Everything is a pure function over an injectable {@link GitRunner} — the
 * fixture suite drives real repositories; unit tests drive scripted runners.
 */

// ---------------------------------------------------------------------------
// Git runner seam
// ---------------------------------------------------------------------------

/** One git invocation result; nonzero exits are RESULTS, not throws. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git with the given args in `cwd`. Only spawn failures reject. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const MAX_BUFFER = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** The production runner (execFile `git`, merged-context discipline). */
export function defaultGitRunner(): GitRunner {
  return async (args, cwd) => {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const probe = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof probe.code === "number") {
        return {
          code: probe.code,
          stdout: typeof probe.stdout === "string" ? probe.stdout : "",
          stderr: typeof probe.stderr === "string" ? probe.stderr : "",
        };
      }
      // Spawn-level failure (git missing, cwd gone): not a git verdict.
      throw new Error(
        `git ${args.join(" ")} failed to run in ${cwd}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

/** Runs git and throws a legible error on nonzero exit. */
async function runOrFail(git: GitRunner, args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Sidecar / collision precheck
// ---------------------------------------------------------------------------

/**
 * The observed sidecar class: omp read-selector spill files (`<path>:<sel>`,
 * e.g. `core.ts:conflicts` — the #418 root-cause residue). `:conflicts` is
 * the contract named by the ticket; keep the detector to the observed class.
 */
export const SIDECAR_SUFFIX = ":conflicts";

/** `.gitignore` line that closes the gap so spills never enter deltas. */
export const SIDECAR_GITIGNORE_LINE = "*:conflicts";

/** True when the path's final segment is a `*:conflicts` spill artifact. */
export function isSidecarPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(SIDECAR_SUFFIX);
}

/** One refusal finding: the cause, the path, and the exact cleanup actions. */
export interface LandingFinding {
  cause: "sidecar-add" | "tracked-collision" | "target-sidecar-residue";
  path: string;
  /** Operator-facing cleanup guidance (exact commands where possible). */
  guidance: string;
}

/** The refusal envelope; `renderLandingRefusal` renders the error text. */
export interface LandingRefusal {
  findings: LandingFinding[];
}

/** Thrown by the release path when the landing precheck refuses (no retention). */
export class LandingRefusalError extends Error {}

/** Strips git's quoting around a path token (`"a/b c"` → `a/b c`). */
function unquotePath(raw: string): string {
  let value = raw;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Added paths in a unified diff (git-generated patch text): sections carrying
 * `new file mode` / `--- /dev/null`, path taken from the `+++ b/<path>` line
 * with the `diff --git` header as the binary-add fallback.
 */
export function addedPathsInPatch(patch: string): string[] {
  const added: string[] = [];
  let headerPath: string | null = null;
  let newFile = false;
  let addDash = false;
  let plusPath: string | null = null;

  const flush = (): void => {
    if (newFile || addDash) {
      const path = plusPath ?? headerPath;
      if (path !== null && path !== "/dev/null" && !added.includes(path)) added.push(path);
    }
    headerPath = null;
    newFile = false;
    addDash = false;
    plusPath = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const rest = line.slice("diff --git ".length);
      const quoted = /^("(?:\\.|[^"])+"|\/dev\/null) ("(?:\\.|[^"])+"|\/dev\/null)$/.exec(rest);
      const parts = quoted ? [quoted[1], quoted[2]] : rest.split(" ");
      const bSideRaw = parts.length >= 2 ? parts[1] : undefined;
      const bSide = typeof bSideRaw === "string" ? unquotePath(bSideRaw) : "";
      headerPath = bSide.startsWith("b/") ? bSide.slice(2) : null;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      newFile = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const target = unquotePath(line.slice(4).trim());
      if (target === "/dev/null") addDash = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = unquotePath(line.slice(4).trim());
      if (target !== "/dev/null") {
        const stripped = target.startsWith("b/") ? target.slice(2) : target;
        if (stripped.length > 0) plusPath = stripped;
      }
    }
  }
  flush();
  return added;
}

/** Tracked paths in the target checkout matching the given pathspecs. */
async function trackedMatching(
  git: GitRunner,
  repoRoot: string,
  pathspecs: string[],
): Promise<string[]> {
  if (pathspecs.length === 0) return [];
  const out = await runOrFail(
    git,
    ["-c", "core.quotePath=false", "ls-files", "-z", "--", ...pathspecs],
    repoRoot,
  );
  return out.split("\0").filter((p) => p.length > 0);
}

/**
 * The landing precheck (#419). Refuses when:
 *  - the captured delta ADDS a `*:conflicts` sidecar (the .gitignore gap —
 *    spills must never land; today's failure class entered the delta exactly
 *    this way), or
 *  - the delta adds any path the target tree already TRACKS (the guaranteed
 *    "already exists → patch does not apply" — decoded here with cleanup), or
 *  - the target tree TRACKS a `*:conflicts` residue (every lane reading that
 *    file spills a colliding add — the wave-wide #418 mechanism).
 *
 * Returns null when the patch may proceed. Pure over {@link GitRunner}.
 */
export async function precheckLandingPatch(
  git: GitRunner,
  repoRoot: string,
  patch: string,
): Promise<LandingRefusal | null> {
  const findings: LandingFinding[] = [];

  const adds = addedPathsInPatch(patch);
  const sidecarAdds = adds.filter((p) => isSidecarPath(p));
  const otherAdds = adds.filter((p) => !isSidecarPath(p));

  for (const path of sidecarAdds) {
    findings.push({
      cause: "sidecar-add",
      path,
      guidance:
        `delete the spill artifact in the lane workspace (rm -- '${path}') and add ` +
        `'${SIDECAR_GITIGNORE_LINE}' to .gitignore so tool-output sidecars never enter the delta`,
    });
  }

  // Collision scan: adds whose path is already tracked in the target tree.
  const tracked = new Set(await trackedMatching(git, repoRoot, otherAdds));
  for (const path of otherAdds) {
    if (tracked.has(path)) {
      findings.push({
        cause: "tracked-collision",
        path,
        guidance:
          `the target tree already tracks '${path}' — drop the duplicate add from the lane delta ` +
          `(delete the untracked copy in the workspace or remove the target's tracked file, #418 class)`,
      });
    }
  }

  // Residue scan: tracked `*:conflicts` files in the target tree.
  const residue = await trackedMatching(git, repoRoot, [SIDECAR_GITIGNORE_LINE]);
  for (const path of residue) {
    findings.push({
      cause: "target-sidecar-residue",
      path,
      guidance:
        `remove the tracked spill residue from the target tree (git rm -- '${path}') and add ` +
        `'${SIDECAR_GITIGNORE_LINE}' to .gitignore — every lane reading that file spills a colliding add`,
    });
  }

  return findings.length > 0 ? { findings } : null;
}

/** Renders the refusal as the operator-facing error text (#419 close-out). */
export function renderLandingRefusal(refusal: LandingRefusal): string {
  const lines = [
    `Landing refused by the task-apply precheck (#419): ${refusal.findings.length} finding(s).`,
  ];
  for (const finding of refusal.findings) {
    lines.push(`- [${finding.cause}] ${finding.path}`);
    lines.push(`    · ${finding.guidance}`);
  }
  lines.push(
    "Clean up in the lane workspace, re-capture, and re-land — the captured patch artifact still holds this delta.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gitlink merge resolution
// ---------------------------------------------------------------------------

/** One resolved gitlink conflict. */
export interface GitlinkResolution {
  path: string;
  ours: string;
  theirs: string;
  winner: "ours" | "theirs";
  /** The staged pointer (the descendant of the two). */
  pin: string;
}

/** An unmerged index entry (`git ls-files --unmerged --stage` row). */
export interface UnmergedEntry {
  mode: string;
  sha: string;
  stage: 1 | 2 | 3;
  path: string;
}

const RAW_DIFF_LINE = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)\t(.+)$/;
const UNMERGED_LINE = /^(\d{6}) ([0-9a-f]+) ([123])\t(.+)$/;

/** Gitlink paths whose pointer changed in `baseSha..branchName` (either side 160000). */
export async function gitlinkPathsInRange(
  git: GitRunner,
  repoRoot: string,
  baseSha: string,
  branchName: string,
): Promise<string[]> {
  const out = await runOrFail(
    git,
    ["-c", "core.quotePath=false", "diff", "--raw", `${baseSha}..${branchName}`],
    repoRoot,
  );
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const match = RAW_DIFF_LINE.exec(line);
    if (match === null) continue;
    const oldMode = match[1];
    const newMode = match[2];
    const path = match[6];
    if (oldMode === undefined || newMode === undefined || path === undefined || path.length === 0) {
      continue;
    }
    if ((oldMode === "160000" || newMode === "160000") && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/** Current unmerged index entries. */
export async function unmergedEntries(git: GitRunner, repoRoot: string): Promise<UnmergedEntry[]> {
  const out = await runOrFail(
    git,
    ["-c", "core.quotePath=false", "ls-files", "--unmerged", "--stage"],
    repoRoot,
  );
  const entries: UnmergedEntry[] = [];
  for (const line of out.split("\n")) {
    const match = UNMERGED_LINE.exec(line);
    if (match === null) continue;
    const mode = match[1];
    const sha = match[2];
    const stage = match[3];
    const path = match[4];
    if (mode === undefined || sha === undefined || stage === undefined || path === undefined) {
      continue;
    }
    entries.push({
      mode,
      sha,
      stage: Number(stage) as 1 | 2 | 3,
      path,
    });
  }
  return entries;
}

export type GitlinkVerdict =
  { ok: true; winner: "ours" | "theirs"; pin: string } | { ok: false; reason: string };

/**
 * Orders two submodule pointers by the submodule's commit graph (#419):
 * when one pin is an ancestor of the other, the descendant contains the
 * ancestor's history and IS the resolution ("后代胜"). Guarded against the
 * un-initialized-submodule trap: `<path>/.git` must exist, else the answer
 * would come from the PARENT repo (`git -C` climbs up) — refuse instead.
 */
export async function resolveGitlinkByAncestry(
  git: GitRunner,
  repoRoot: string,
  path: string,
  ours: string,
  theirs: string,
): Promise<GitlinkVerdict> {
  if (ours === theirs) return { ok: true, winner: "ours", pin: ours };

  const submoduleDir = join(repoRoot, path);
  if (!existsSync(join(submoduleDir, ".git"))) {
    return {
      ok: false,
      reason:
        `submodule '${path}' is not initialized (no .git in ${submoduleDir}) — ancestry is ` +
        `unverifiable and git would answer from the parent repo; run ` +
        `git submodule update --init -- '${path}' (or land the pin manually)`,
    };
  }

  const theirsIsAncestor = await git(["merge-base", "--is-ancestor", theirs, ours], submoduleDir);
  if (theirsIsAncestor.code === 0) {
    return { ok: true, winner: "ours", pin: ours };
  }
  const oursIsAncestor = await git(["merge-base", "--is-ancestor", ours, theirs], submoduleDir);
  if (oursIsAncestor.code === 0) {
    return { ok: true, winner: "theirs", pin: theirs };
  }
  if (theirsIsAncestor.code !== 1 || oursIsAncestor.code !== 1) {
    const probe = theirsIsAncestor.code !== 1 ? theirsIsAncestor : oursIsAncestor;
    return {
      ok: false,
      reason:
        `submodule '${path}' could not answer the ancestry query ` +
        `(exit ${probe.code}: ${probe.stderr.trim()})`,
    };
  }
  return {
    ok: false,
    reason:
      `submodule '${path}' pins are genuinely divergent ` +
      `(ours ${ours.slice(0, 12)}, theirs ${theirs.slice(0, 12)} — neither is an ancestor)`,
  };
}

/** Outcome of the resolving cherry-pick retry. */
export interface CherryPickOutcome {
  ok: boolean;
  /** Human-readable resolution log (landed pins, skipped empties). */
  notes: string[];
  /** Why the retry gave up (when `!ok`); the original merge error still stands. */
  error?: string;
}

/**
 * Replays `baseSha..branchName` onto HEAD with gitlink-conflict resolution
 * (the #419 retry engine). Only engages when the range actually touches a
 * gitlink; any non-gitlink conflict, divergent pin, or unverifiable submodule
 * aborts cleanly (state restored) so the caller reports the original conflict.
 *
 * Stash discipline mirrors omp mergeTaskBranches: a dirty tree is stashed
 * before the pick and popped after; a conflicted pop keeps the stash entry
 * (never loses WIP) and leaves a note.
 */
export async function cherryPickRangeWithGitlinkResolution(
  git: GitRunner,
  repoRoot: string,
  baseSha: string,
  branchName: string,
): Promise<CherryPickOutcome> {
  const notes: string[] = [];

  const gitlinks = await gitlinkPathsInRange(git, repoRoot, baseSha, branchName);
  if (gitlinks.length === 0) {
    return { ok: false, notes, error: "the cherry-pick range does not touch a gitlink" };
  }

  const countOut = await git(["rev-list", "--count", `${baseSha}..${branchName}`], repoRoot);
  const commitCount = countOut.code === 0 ? Number.parseInt(countOut.stdout.trim(), 10) : 0;
  const maxIterations = Math.max(16, (Number.isNaN(commitCount) ? 0 : commitCount) * 4 + 8);

  const status = await git(["status", "--porcelain"], repoRoot);
  const stashed = status.stdout.trim().length > 0;
  if (stashed) {
    await runOrFail(git, ["stash", "push", "-m", "omp-task-merge-resolve"], repoRoot);
  }

  const popStash = async (): Promise<void> => {
    if (!stashed) return;
    const pop = await git(["stash", "pop"], repoRoot);
    if (pop.code !== 0) {
      notes.push(
        "stash pop conflicted — the merged commits are on HEAD; the stash entry is preserved, " +
          "run `git stash pop` and resolve manually",
      );
    }
  };

  const abortPick = async (): Promise<void> => {
    await git(["cherry-pick", "--abort"], repoRoot).catch(() => undefined);
  };

  try {
    let attempt = await git(
      ["-c", "core.editor=true", "cherry-pick", `${baseSha}..${branchName}`],
      repoRoot,
    );
    let iterations = 0;
    while (attempt.code !== 0) {
      if (iterations++ >= maxIterations) {
        throw new Error(`cherry-pick resolution exceeded ${maxIterations} iterations`);
      }
      const entries = await unmergedEntries(git, repoRoot);
      if (entries.length === 0) {
        // Empty-pick stop ("The previous cherry-pick is now empty"): skip and
        // continue — a resolved pin bump already contained in HEAD hits this.
        if (/now empty|nothing to commit/i.test(attempt.stderr)) {
          attempt = await git(["-c", "core.editor=true", "cherry-pick", "--skip"], repoRoot);
          continue;
        }
        throw new Error(`cherry-pick stopped without unmerged entries: ${attempt.stderr.trim()}`);
      }

      const modes = new Set(entries.map((e) => e.mode));
      if (modes.size !== 1 || !modes.has("160000")) {
        throw new Error(
          `conflict is not gitlink-only (unmerged modes: ${[...modes].join(", ")}) — real conflict`,
        );
      }

      const paths = [...new Set(entries.map((e) => e.path))];
      for (const path of paths) {
        const stage2 = entries.find((e) => e.path === path && e.stage === 2);
        const stage3 = entries.find((e) => e.path === path && e.stage === 3);
        if (stage2 === undefined || stage3 === undefined) {
          throw new Error(
            `gitlink conflict in '${path}' misses ours/theirs stages (delete/modify shape)`,
          );
        }
        const verdict = await resolveGitlinkByAncestry(git, repoRoot, path, stage2.sha, stage3.sha);
        if (!verdict.ok) throw new Error(verdict.reason);
        await runOrFail(
          git,
          ["update-index", "--cacheinfo", `160000,${verdict.pin},${path}`],
          repoRoot,
        );
        notes.push(
          `gitlink '${path}': took the ${verdict.winner === "ours" ? "target (descendant)" : "incoming (descendant)"} ` +
            `pin ${verdict.pin.slice(0, 12)} — other side ${verdict.winner === "ours" ? stage3.sha.slice(0, 12) : stage2.sha.slice(0, 12)} is its ancestor`,
        );
      }

      attempt = await git(["-c", "core.editor=true", "cherry-pick", "--continue"], repoRoot);
    }

    await popStash();
    return { ok: true, notes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await abortPick();
    await popStash();
    return { ok: false, notes, error: message };
  }
}
