import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertImplementationContract } from "../dist/factory/orchestrator.js";

/**
 * Regression tests for the Implementation Acceptance Contract. The contract
 * gates the implementation stage so a half-finished implementation
 * (uncommitted files, unpushed branch, branch/commit drift) cannot slip
 * past review-pr and surface later as a vague "implementation failed"
 * supervisor routing.
 *
 * Each test builds a real git worktree so the assertions are run against
 * the same execSync paths the orchestrator uses in production.
 */

function git(cwd, args) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

async function buildWorktreeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-contract-"));
    const repo = path.join(root, "repo");
    const remote = path.join(root, "remote.git");

    mkdirSync(repo);
    git(root, ["init", "--bare", remote]);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "factory@test.local"]);
    git(repo, ["config", "user.name", "Factory Test"]);
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);

    // Worktree for the issue under test.
    const worktree = path.join(root, "work");
    git(repo, ["worktree", "add", "-b", "feature/issue-7-test", worktree]);
    writeFileSync(path.join(worktree, "app.ts"), "export const app = true;\n");
    git(worktree, ["add", "app.ts"]);
    git(worktree, ["commit", "-m", "implement app"]);
    // Push with explicit refspec so the bare repo accepts the branch and
    // the worktree sees origin/feature/issue-7-test immediately on next
    // fetch.
    git(worktree, ["push", "origin", "HEAD:refs/heads/feature/issue-7-test"]);
    // Fetch from origin so the worktree's local remote-tracking refs
    // are populated. Without this, `git rev-parse origin/feature/...`
    // returns nothing in some worktree setups.
    git(repo, ["fetch", "origin", "feature/issue-7-test"]);

    return { root, repo, worktree };
}

test("accepts a clean implementation branch with matching commit", async (t) => {
    const { root, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const head = git(worktree, ["rev-parse", "HEAD"]);
    await assertImplementationContract(
        { commitSha: head, branch: "feature/issue-7-test" },
        { owner: "x", name: "y", defaultBranch: "main", workdir: worktree },
        7,
        {},
    );
});

test("rejects when the implementation branch was never pushed to origin", async (t) => {
    const { root, repo, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    // Create a feature branch but never push it.
    mkdirSync(path.join(root, "unpushed"), { recursive: true });
    git(repo, ["worktree", "add", "-b", "feature/issue-8-test", path.join(root, "unpushed")]);
    writeFileSync(path.join(root, "unpushed", "app.ts"), "// new\n");
    git(path.join(root, "unpushed"), ["add", "app.ts"]);
    git(path.join(root, "unpushed"), ["commit", "-m", "unpushed"]);

    const head = git(path.join(root, "unpushed"), ["rev-parse", "HEAD"]);
    await assert.rejects(
        () => assertImplementationContract(
            { commitSha: head, branch: "feature/issue-8-test" },
            { owner: "x", name: "y", defaultBranch: "main", workdir: path.join(root, "unpushed") },
            8,
            {},
        ),
        /never pushed to origin/,
    );
});

test("rejects when the working tree is dirty", async (t) => {
    const { root, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const head = git(worktree, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(worktree, "scratch.ts"), "// uncommitted\n");
    await assert.rejects(
        () => assertImplementationContract(
            { commitSha: head, branch: "feature/issue-7-test" },
            { owner: "x", name: "y", defaultBranch: "main", workdir: worktree },
            7,
            {},
        ),
        /dirty working tree/,
    );
});

test("rejects when commitSha drifts from the branch on origin", async (t) => {
    const { root, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    // Push a second commit so origin's HEAD is now ahead of what we
    // recorded. The contract should detect the drift.
    writeFileSync(path.join(worktree, "followup.ts"), "// followup\n");
    git(worktree, ["add", "followup.ts"]);
    git(worktree, ["commit", "-m", "followup"]);
    // Push the followup commit to the same feature branch on origin.
    git(worktree, ["push", "origin", "HEAD:refs/heads/feature/issue-7-test"]);
    // Refresh the worktree's remote-tracking refs so the contract sees
    // the new HEAD on origin/<branch>.
    git(worktree, ["fetch", "origin", "feature/issue-7-test"]);

    const recordedSha = git(worktree, ["rev-parse", "HEAD~1"]);
    await assert.rejects(
        () => assertImplementationContract(
            { commitSha: recordedSha, branch: "feature/issue-7-test" },
            { owner: "x", name: "y", defaultBranch: "main", workdir: worktree },
            7,
            {},
        ),
        /commitSha drift/,
    );
});

test("rejects when implementation returns no commitSha at all", async (t) => {
    const { root, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    await assert.rejects(
        () => assertImplementationContract(
            { branch: "feature/issue-7-test" },
            { owner: "x", name: "y", defaultBranch: "main", workdir: worktree },
            7,
            {},
        ),
        /commitSha/,
    );
});

test("rejects when implementation returns no branch at all", async (t) => {
    const { root, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const head = git(worktree, ["rev-parse", "HEAD"]);
    await assert.rejects(
        () => assertImplementationContract(
            { commitSha: head },
            { owner: "x", name: "y", defaultBranch: "main", workdir: worktree },
            7,
            {},
        ),
        /branch/,
    );
});

test("rejects when the branch name does not match the issue number convention", async (t) => {
    const { root, worktree } = await buildWorktreeFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const head = git(worktree, ["rev-parse", "HEAD"]);
    await assert.rejects(
        () => assertImplementationContract(
            { commitSha: head, branch: "feature/issue-99-mismatch" },
            { owner: "x", name: "y", defaultBranch: "main", workdir: worktree },
            7,
            {},
        ),
        /feature\/issue-7-/,
    );
});
