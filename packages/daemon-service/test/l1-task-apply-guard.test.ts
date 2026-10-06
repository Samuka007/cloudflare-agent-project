import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeTaskBranches } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addedPathsInPatch,
  cherryPickRangeWithGitlinkResolution,
  defaultGitRunner,
  isSidecarPath,
  precheckLandingPatch,
  renderLandingRefusal,
  resolveGitlinkByAncestry,
  type GitRunner,
} from "../src/client/task-apply-guard.js";

/**
 * L1 for the task-apply landing guard (#419) — runs under Bun (real git
 * fixtures; the guard module is node-ambient). Acceptance anchors from the
 * ticket:
 *   - 双侧 pin 分叉 fixture：apply 自动取后代、零冲突 (both directions of
 *     the ancestor order + the divergent control that still reports)
 *   - 含 sidecar 的 lane 补丁：预检拒绝 + 清理指引 (sidecar adds, tracked
 *     collisions, and the tracked `*:conflicts` residue)
 *   - 未 init 子模块守卫：ancestry 绝不从父仓作答（origin-drift 机制链）
 */

const runner: GitRunner = defaultGitRunner();

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omp-apply-guard-"));
});

function mkRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "guard-l1@example.test");
  git(dir, "config", "user.name", "guard-l1");
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitAllowFailure(cwd: string, ...args: string[]): { code: number; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: (result.stdout ?? "").trim() };
}

function commit(cwd: string, message: string): string {
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

// ---------------------------------------------------------------------------
// Sidecar / collision precheck
// ---------------------------------------------------------------------------

describe("landing precheck (#419)", () => {
  test("addedPathsInPatch: adds only — modifies and deletes excluded, binary adds caught", () => {
    const patch = [
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1 @@",
      "+new",
      "diff --git a/docs/keep.md b/docs/keep.md",
      "index 2222222..3333333 100644",
      "--- a/docs/keep.md",
      "+++ b/docs/keep.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/docs/gone.md b/docs/gone.md",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/docs/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/bin/blob.dat b/bin/blob.dat",
      "new file mode 100644",
      "index 0000000..5555555",
      "GIT binary patch",
      "literal 4",
    ].join("\n");
    expect(addedPathsInPatch(patch)).toEqual(["docs/new.md", "bin/blob.dat"]);
  });

  test("isSidecarPath: the `*:conflicts` family only", () => {
    expect(isSidecarPath("plugins/pm-harness/src/core.ts:conflicts")).toBe(true);
    expect(isSidecarPath("core.ts:conflicts")).toBe(true);
    expect(isSidecarPath("core.ts")).toBe(false);
    expect(isSidecarPath("notes:conflicts.md")).toBe(false);
  });

  test("sidecar add refuses with cleanup guidance (the .gitignore gap)", async () => {
    const repo = mkRepo("precheck-sidecar");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", ".");
    commit(repo, "seed");
    const patch = [
      "diff --git a/src/core.ts:conflicts b/src/core.ts:conflicts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/core.ts:conflicts",
      "@@ -0,0 +1 @@",
      "+3: leaked listing",
    ].join("\n");
    const refusal = await precheckLandingPatch(runner, repo, patch);
    expect(refusal).not.toBeNull();
    const findings = refusal?.findings ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toBe("sidecar-add");
    expect(findings[0]?.path).toBe("src/core.ts:conflicts");
    expect(findings[0]?.guidance).toContain("rm -- 'src/core.ts:conflicts'");
    expect(findings[0]?.guidance).toContain("*:conflicts");
    const text = renderLandingRefusal(refusal ?? { findings: [] });
    expect(text).toContain("Landing refused by the task-apply precheck (#419)");
    expect(text).toContain(".gitignore");
  });

  test("tracked collision decodes the 'already exists' failure before apply", async () => {
    const repo = mkRepo("precheck-collision");
    writeFileSync(join(repo, "docs.md"), "tracked\n");
    git(repo, "add", ".");
    commit(repo, "seed");
    const patch = [
      "diff --git a/docs.md b/docs.md",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/docs.md",
      "@@ -0,0 +1 @@",
      "+dup",
    ].join("\n");
    const refusal = await precheckLandingPatch(runner, repo, patch);
    expect(refusal?.findings[0]?.cause).toBe("tracked-collision");
    expect(refusal?.findings[0]?.path).toBe("docs.md");
  });

  test("tracked `*:conflicts` residue in the target tree refuses even a clean patch", async () => {
    const repo = mkRepo("precheck-residue");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/core.ts:conflicts"), "3: residue\n");
    git(repo, "add", "--", "src/core.ts:conflicts");
    commit(repo, "seed residue");
    const refusal = await precheckLandingPatch(runner, repo, "");
    expect(refusal?.findings[0]?.cause).toBe("target-sidecar-residue");
    expect(refusal?.findings[0]?.path).toBe("src/core.ts:conflicts");
    expect(refusal?.findings[0]?.guidance).toContain("git rm");
  });

  test("clean production patch passes", async () => {
    const repo = mkRepo("precheck-clean");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", ".");
    commit(repo, "seed");
    const patch = [
      "diff --git a/fresh.md b/fresh.md",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/fresh.md",
      "@@ -0,0 +1 @@",
      "+fresh",
    ].join("\n");
    expect(await precheckLandingPatch(runner, repo, patch)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gitlink ancestry fixture (the five-lane 2026-10-06 shape)
// ---------------------------------------------------------------------------

describe("gitlink merge resolution (#419)", () => {
  let repo: string;
  let subSrc: string;
  let shaA: string;
  let shaB: string;
  let shaC: string;
  let shaD: string;
  let shaE: string;
  let base: string;

  beforeAll(() => {
    // Submodule history: A → B → C → {D, E} (D and E divergent siblings).
    subSrc = mkRepo("gitsub");
    writeFileSync(join(subSrc, "s.txt"), "a\n");
    git(subSrc, "add", ".");
    shaA = commit(subSrc, "A");
    writeFileSync(join(subSrc, "s.txt"), "b\n");
    git(subSrc, "add", ".");
    shaB = commit(subSrc, "B");
    writeFileSync(join(subSrc, "s.txt"), "c\n");
    git(subSrc, "add", ".");
    shaC = commit(subSrc, "C");
    git(subSrc, "checkout", "-q", "-b", "d", shaC);
    writeFileSync(join(subSrc, "s.txt"), "d\n");
    git(subSrc, "add", ".");
    shaD = commit(subSrc, "D");
    git(subSrc, "checkout", "-q", "-b", "e", shaC);
    writeFileSync(join(subSrc, "s.txt"), "e\n");
    git(subSrc, "add", ".");
    shaE = commit(subSrc, "E");

    repo = mkRepo("gitlink-repo");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", ".");
    commit(repo, "seed");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", subSrc, "sub");
    git(repo, "update-index", "--cacheinfo", `160000,${shaA},sub`);
    base = commit(repo, "base pin A");
    // Main advances its pin to C (the descendant the incident's main HEAD had).
    git(repo, "update-index", "--cacheinfo", `160000,${shaC},sub`);
    commit(repo, "advance pin to C");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Lane branch from `base`: prose file + a pin bump to `pin`. */
  function laneBranch(name: string, pin: string, prose: string): void {
    git(repo, "checkout", "-q", "-B", name, base);
    writeFileSync(join(repo, `${prose}.txt`), `${prose}\n`);
    git(repo, "add", `${prose}.txt`);
    git(repo, "update-index", "--cacheinfo", `160000,${pin},sub`);
    commit(repo, `lane work ${name}`);
    git(repo, "checkout", "-q", "main");
  }

  function headPin(): string {
    return git(repo, "rev-parse", "HEAD:sub");
  }

  function unmerged(): string {
    return git(repo, "ls-files", "--unmerged", "--stage");
  }

  test("control: plain cherry-pick reproduces the 0-file gitlink fake conflict", async () => {
    // The natives-backed landing chain (the incident's dose): a pin bump
    // whose two sides are ancestry-ordered still reports a 0-file conflict.
    laneBranch("omp/task/fix1", shaB, "lane1");
    const merge = await mergeTaskBranches(repo, [
      { branchName: "omp/task/fix1", taskId: "fix1", baseSha: base },
    ]);
    expect(merge.failed).toEqual(["omp/task/fix1"]);
    expect(merge.conflict).toContain("merge conflict in 0 file(s)");
  });

  test("ours is the descendant: the incoming ancestor pin is contained, zero conflicts", async () => {
    // Recovery primitive of the release path: the CLI-based retry resolves
    // what the natives chain refused — the ordered pins land, zero conflicts
    // (the CLI merges ancestry-ordered submodule pointers natively; the
    // engine's explicit ancestry stage covers git builds that do not).
    const outcome = await cherryPickRangeWithGitlinkResolution(runner, repo, base, "omp/task/fix1");
    expect(outcome.ok).toBe(true);
    expect(headPin()).toBe(shaC);
    expect(readFileSync(join(repo, "lane1.txt"), "utf8")).toContain("lane1");
    expect(unmerged()).toBe("");
  });

  test("incoming is the descendant: the lane's newer pin wins (后代胜)", async () => {
    laneBranch("omp/task/fix2", shaD, "lane2");
    const merge = await mergeTaskBranches(repo, [
      { branchName: "omp/task/fix2", taskId: "fix2", baseSha: base },
    ]);
    expect(merge.failed).toEqual(["omp/task/fix2"]);
    const outcome = await cherryPickRangeWithGitlinkResolution(runner, repo, base, "omp/task/fix2");
    expect(outcome.ok).toBe(true);
    expect(headPin()).toBe(shaD);
    expect(readFileSync(join(repo, "lane2.txt"), "utf8")).toContain("lane2");
    expect(unmerged()).toBe("");
  });

  test("divergent pins are a real conflict — reported, state restored", async () => {
    const pinBefore = headPin();
    laneBranch("omp/task/fix3", shaE, "lane3");
    const merge = await mergeTaskBranches(repo, [
      { branchName: "omp/task/fix3", taskId: "fix3", baseSha: base },
    ]);
    expect(merge.failed).toEqual(["omp/task/fix3"]);
    const outcome = await cherryPickRangeWithGitlinkResolution(runner, repo, base, "omp/task/fix3");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("genuinely divergent");
    expect(headPin()).toBe(pinBefore);
    expect(existsSync(join(repo, "lane3.txt"))).toBe(false);
    expect(unmerged()).toBe("");
  });

  test("unverifiable ancestry (missing pin objects) refuses instead of guessing", async () => {
    // An incoming pin whose commit is absent from the submodule's object
    // store: the ancestry query cannot answer, so the guard must refuse —
    // never stage a pin it could not order.
    const foreign = mkRepo("foreignsub");
    writeFileSync(join(foreign, "f.txt"), "f\n");
    git(foreign, "add", ".");
    const foreignSha = commit(foreign, "F");
    const pinBefore = headPin();
    laneBranch("omp/task/fix5", foreignSha, "lane5");
    const merge = await mergeTaskBranches(repo, [
      { branchName: "omp/task/fix5", taskId: "fix5", baseSha: base },
    ]);
    expect(merge.failed).toEqual(["omp/task/fix5"]);
    const outcome = await cherryPickRangeWithGitlinkResolution(runner, repo, base, "omp/task/fix5");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("could not answer the ancestry query");
    expect(headPin()).toBe(pinBefore);
    expect(unmerged()).toBe("");
  });

  test("direct ancestry verdict: unrelated pins refuse; ancestor order resolves", async () => {
    const verdict = await resolveGitlinkByAncestry(runner, repo, "sub", shaD, shaE);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("genuinely divergent");
    const ordered = await resolveGitlinkByAncestry(runner, repo, "sub", shaB, shaC);
    expect(ordered.ok).toBe(true);
    if (ordered.ok) {
      expect(ordered.winner).toBe("theirs");
      expect(ordered.pin).toBe(shaC);
    }
  });

  test("un-initialized submodule: refuses instead of answering from the parent repo", async () => {
    // Divergent pins force a real conflict; with the submodule's .git gone,
    // `git -C sub` would answer from the PARENT repo (the #419 origin-drift
    // mechanism) — the guard must refuse before any submodule git call.
    const pinBefore = headPin();
    laneBranch("omp/task/fix4", shaE, "lane4");
    rmSync(join(repo, "sub", ".git"));
    const outcome = await cherryPickRangeWithGitlinkResolution(runner, repo, base, "omp/task/fix4");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not initialized");
    expect(outcome.error).toContain("git submodule update --init");
    // The trap shape: nothing entered cherry-pick state, HEAD untouched.
    expect(unmerged()).toBe("");
    expect(headPin()).toBe(pinBefore);
    expect(existsSync(join(repo, "lane4.txt"))).toBe(false);
  });
});
