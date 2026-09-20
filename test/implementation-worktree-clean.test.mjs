// Regression test for the worktree auto-clean step at the start of
// ImplementationAgent.run(). The worktree is persistent across daemon
// restarts; a previous implementation that crashed before its final
// `git add -A && git commit` leaves untracked files behind, and the
// next attempt sees "Target checkout is not clean: <untracked>" and
// aborts before doing any work. Issue #24 sat in this state for hours
// after a force-killed daemon left `template/src/test/debug-css.test.tsx`
// on disk.
//
// The fix is `git clean -fd` with the same carve-outs as changedFiles,
// scoped to the worktree, before the initial cleanliness check. This
// test exercises the same shell commands the production code runs so
// regressions in the exclusion list (or a `--exclude` typo) surface here
// instead of in production.

import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCb);

/**
 * The exact carve-out list the production code passes to
 * `git clean -fd --`. Keep this in sync with the call site in
 * src/agents/implementation.ts; if the production list changes,
 * update this array or the test will pass while production does
 * the wrong thing.
 */
const CLEAN_EXCLUDES = [
  "--exclude=factory", "--exclude=node_modules", "--exclude=evidence",
  "--exclude=dist", "--exclude=build", "--exclude=coverage",
  "--exclude=*.tsbuildinfo", "--exclude=.DS_Store",
];

async function makeWorktreeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-impl-clean-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Bare remote — the worktree will track it.
  const remote = path.join(root, "remote.git");
  await execFile("git", ["init", "--bare", remote]);

  // Source repo with one initial commit.
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await execFile("git", ["init", "-b", "main"], { cwd: source });
  await execFile("git", ["config", "user.email", "ci@test.local"], { cwd: source });
  await execFile("git", ["config", "user.name", "CI"], { cwd: source });
  await fs.writeFile(path.join(source, "README.md"), "fixture\n");
  await execFile("git", ["add", "README.md"], { cwd: source });
  await execFile("git", ["commit", "-m", "fixture"], { cwd: source });
  await execFile("git", ["remote", "add", "origin", remote], { cwd: source });
  await execFile("git", ["push", "-u", "origin", "main"], { cwd: source });

  // Worktree for issue 7.
  const worktree = path.join(root, "issue-7");
  await execFile("git", ["-C", source, "worktree", "add", "--detach", worktree, "origin/main"]);
  return { root, source, worktree };
}

/**
 * Reproduce the production call sequence:
 *   git clean -fd <carve-outs> --
 * followed by the same `git status --porcelain`/`git diff HEAD` style
 * check the agent runs (changedFiles is tested separately; here we
 * just need to confirm the leftover untracked file is gone).
 */
async function runAutoClean(cwd) {
  await execFile(
    "git",
    ["clean", "-fd", ...CLEAN_EXCLUDES, "--"],
    { cwd },
  );
}

/**
 * Reproduce the FULL production auto-clean sequence for a given feature
 * branch: `git clean -fd` plus the UNCONDITIONAL `git reset --hard HEAD`
 * that clears tracked-but-modified debris from a previous, killed attempt.
 *
 * Issue #29 (2026-09-17): the reset used to be gated on
 * `origin/${branch} == HEAD`, which skipped it exactly when a
 * timeout-killed first attempt left debris on a branch that was never
 * pushed — looping "Target checkout is not clean" forever. The reset
 * only discards UNCOMMITTED changes (commits, pushed or not, survive),
 * and at attempt start any uncommitted change is debris by definition.
 * Mirrors `src/agents/implementation.ts`.
 */
async function runAutoCleanAndReset(cwd, _branch) {
  await runAutoClean(cwd);
  await execFile("git", ["reset", "--hard", "HEAD"], { cwd });
}

test("auto-clean removes untracked files left by a previous implementation", async (t) => {
  const { worktree } = await makeWorktreeFixture(t);
  const stale = path.join(worktree, "template", "src", "test", "debug-css.test.tsx");
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, "// smoke test\n");

  // Sanity: the file exists on disk before clean.
  const beforeStat = await fs.stat(stale);
  assert.ok(beforeStat.isFile());

  await runAutoClean(worktree);

  // After auto-clean, the file is gone and `git status --porcelain`
  // reports no untracked entries. We use `--untracked-files=all` so
  // git descends into the now-removed directory tree if anything is
  // left behind; the contract is "no untracked entries, period".
  const after = await execFile(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: worktree },
  );
  assert.equal(after.stdout.trim(), "", `expected clean status, got:\n${after.stdout}`);
  await assert.rejects(fs.access(stale), /ENOENT/);
});

test("auto-clean preserves tracked-but-modified files (live agent work)", async (t) => {
  const { worktree } = await makeWorktreeFixture(t);
  // Track a new file via commit, then modify it in-place. This is the
  // shape an in-progress agent's work would take.
  const tracked = path.join(worktree, "src.ts");
  await fs.mkdir(path.dirname(tracked), { recursive: true });
  await fs.writeFile(tracked, "v1\n");
  await execFile("git", ["add", "src.ts"], { cwd: worktree });
  await execFile("git", ["commit", "-m", "tracked"], { cwd: worktree });
  await fs.writeFile(tracked, "v2 in progress\n");

  await runAutoClean(worktree);

  const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree });
  // The " M src.ts" line should still be there — clean only touches
  // untracked, not tracked modifications.
  assert.match(status.stdout, / M src\.ts/);
  const content = await fs.readFile(tracked, "utf8");
  assert.equal(content, "v2 in progress\n");
});

test("auto-clean respects excludes (factory/, node_modules/, dist/, etc.)", async (t) => {
  const { worktree } = await makeWorktreeFixture(t);
  // Plant untracked files inside directories the auto-clean should
  // spare. None of these are in .gitignore for the fixture repo, so
  // a naive `git clean -fd` (no --exclude) would delete them.
  for (const dir of ["factory", "node_modules", "evidence", "dist", "build", "coverage"]) {
    const file = path.join(worktree, dir, "keep.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `// ${dir} content\n`);
  }
  // Also plant a tsbuildinfo and a .DS_Store at the worktree root.
  await fs.writeFile(path.join(worktree, "x.tsbuildinfo"), "");
  await fs.writeFile(path.join(worktree, ".DS_Store"), "");

  await runAutoClean(worktree);

  for (const dir of ["factory", "node_modules", "evidence", "dist", "build", "coverage"]) {
    const file = path.join(worktree, dir, "keep.ts");
    await fs.access(file); // throws ENOENT if the carve-out didn't hold
  }
  // tsbuildinfo + DS_Store also spared.
  await fs.access(path.join(worktree, "x.tsbuildinfo"));
  await fs.access(path.join(worktree, ".DS_Store"));
});

test("auto-clean is safe to run on an already-clean worktree (no-op)", async (t) => {
  const { worktree } = await makeWorktreeFixture(t);
  // No mutations.
  await runAutoClean(worktree);
  const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout.trim(), "");
});

test("auto-clean spares files covered by .gitignore (no -x in production)", async (t) => {
  // `git clean -fd` (without `-x`) respects .gitignore: a file matched
  // by an ignore rule is left alone. The carve-out list in the
  // production code is for paths the agent knows it should never touch
  // even if they're NOT gitignored; .gitignore is the canonical source
  // for the common case. This test pins the behaviour so a future
  // "let me add -x to be safe" change surfaces here instead of
  // silently deleting build artefacts the user wanted gitignored.
  const { worktree } = await makeWorktreeFixture(t);
  await fs.writeFile(path.join(worktree, ".gitignore"), ".tmp-test/\n");
  await fs.mkdir(path.join(worktree, ".tmp-test"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".tmp-test", "scratch.ts"), "// scratch\n");

  await runAutoClean(worktree);

  // .gitignore was untracked and got removed by clean; after removal,
  // .tmp-test/scratch.ts appears as `??` in `git status`. Either way
  // the file should be on disk and untouched.
  const scratchPath = path.join(worktree, ".tmp-test", "scratch.ts");
  const content = await fs.readFile(scratchPath, "utf8");
  assert.equal(content, "// scratch\n", "gitignored file must not be removed");
});

/**
 * Spin a worktree that is checked out on a real feature branch with
 * the upstream tracking set up. The `push` step makes
 * `origin/${branch}` resolve to the same commit as local HEAD, which
 * is the gate condition the production reset fires under.
 *
 * Pin `core.autocrlf=false` so cross-platform file content is
 * deterministic — the default `true` on Windows turns LF into CRLF
 * on checkout, which would make the "file must be reset to HEAD
 * content" assertion compare different strings on different hosts.
 */
async function makeFeatureWorktreeFixture(t, branch) {
  const fixture = await makeWorktreeFixture(t);
  const { source, worktree } = fixture;
  await execFile("git", ["config", "core.autocrlf", "false"], { cwd: source });
  await execFile("git", ["config", "core.autocrlf", "false"], { cwd: worktree });
  await execFile("git", ["checkout", "-b", branch], { cwd: worktree });
  await execFile("git", ["push", "-u", "origin", branch], { cwd: source });
  return { ...fixture, branch };
}

test("tracked-modified debris is reset when origin/branch == HEAD (issue #24 fix)", async (t) => {
  // Reproduces the issue #24 failure mode: the previous implementation
  // attempt wrote debug instrumentation (a cssTracePlugin) to
  // template/vite.config.ts and was killed before `commit_and_push`.
  // The next attempt must clear that debris instead of tripping
  // "Target checkout is not clean" forever.
  const { worktree, branch } = await makeFeatureWorktreeFixture(t, "feature/issue-24-add-kanban");
  const tracked = path.join(worktree, "template", "vite.config.ts");
  await fs.mkdir(path.dirname(tracked), { recursive: true });
  // Commit a clean v1, push, then modify in place to simulate the
  // killed debug-instrumentation case.
  await fs.writeFile(tracked, "v1 committed\n");
  await execFile("git", ["add", tracked], { cwd: worktree });
  await execFile("git", ["commit", "-m", "v1"], { cwd: worktree });
  await execFile("git", ["push", "origin", branch], { cwd: worktree });
  await fs.writeFile(tracked, "v2 cssTracePlugin debug instrumentation\n");

  await runAutoCleanAndReset(worktree, branch);

  // Tracked-modified debris must be gone after the gated reset.
  const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout.trim(), "", `expected clean status, got:\n${status.stdout}`);
  const content = await fs.readFile(tracked, "utf8");
  assert.equal(content, "v1 committed\n", "tracked file must be reset to HEAD content");
});

test("unpushed local commits survive while uncommitted debris is reset", async (t) => {
  // `git reset --hard HEAD` must never destroy COMMITS — only
  // uncommitted working-tree changes. An unpushed local commit stays
  // intact; the uncommitted v3 debris on top of it is discarded
  // (at attempt start, uncommitted == debris from a killed attempt).
  const { worktree, branch } = await makeFeatureWorktreeFixture(t, "feature/issue-9-live-work");
  const tracked = path.join(worktree, "src.ts");
  await fs.mkdir(path.dirname(tracked), { recursive: true });
  await fs.writeFile(tracked, "v1\n");
  await execFile("git", ["add", tracked], { cwd: worktree });
  await execFile("git", ["commit", "-m", "v1"], { cwd: worktree });
  await execFile("git", ["push", "origin", branch], { cwd: worktree });
  // Make a LOCAL-ONLY commit (not pushed) so origin/branch lags HEAD.
  await fs.writeFile(tracked, "v2 local commit\n");
  await execFile("git", ["add", tracked], { cwd: worktree });
  await execFile("git", ["commit", "-m", "v2 unpushed"], { cwd: worktree });
  // Uncommitted debris on top of the unpushed commit.
  await fs.writeFile(tracked, "v3 in progress\n");

  await runAutoCleanAndReset(worktree, branch);

  // The unpushed commit is preserved; the uncommitted debris is gone.
  const content = await fs.readFile(tracked, "utf8");
  assert.equal(content, "v2 local commit\n", "unpushed COMMIT must survive; uncommitted debris must be reset");
  const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout.trim(), "", `expected clean status, got:\n${status.stdout}`);
  const { stdout: logOut } = await execFile("git", ["log", "--oneline", "-1"], { cwd: worktree });
  assert.match(logOut, /v2 unpushed/, "HEAD must still point at the unpushed commit");
});

test("tracked-modified debris is reset when origin/branch does not exist (issue #29 fix)", async (t) => {
  // Issue #29 (2026-09-17): a timeout-killed FIRST attempt left
  // tracked-modified debris on a branch that was never pushed. The old
  // gate skipped the reset (no origin/branch to compare), so every
  // retry tripped "Target checkout is not clean" and the daemon looped
  // supervisor → implementation → fail forever. The reset must fire
  // regardless of the remote branch state.
  const { worktree, source } = await makeWorktreeFixture(t);
  // Pin autocrlf so `reset --hard` content comparisons are deterministic
  // on Windows (default autocrlf=true would rewrite LF as CRLF).
  await execFile("git", ["config", "core.autocrlf", "false"], { cwd: source });
  await execFile("git", ["config", "core.autocrlf", "false"], { cwd: worktree });
  await execFile("git", ["checkout", "-b", "feature/issue-1-fresh"], { cwd: worktree });
  const tracked = path.join(worktree, "src.ts");
  await fs.mkdir(path.dirname(tracked), { recursive: true });
  await fs.writeFile(tracked, "v1\n");
  await execFile("git", ["add", tracked], { cwd: worktree });
  await execFile("git", ["commit", "-m", "v1"], { cwd: worktree });
  await fs.writeFile(tracked, "v2 debris from killed attempt\n");

  await runAutoCleanAndReset(worktree, "feature/issue-1-fresh");

  const content = await fs.readFile(tracked, "utf8");
  assert.equal(content, "v1\n", "debris must be reset even when origin/branch does not exist");
  const status = await execFile("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout.trim(), "", `expected clean status, got:\n${status.stdout}`);
});
