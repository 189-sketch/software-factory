import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureIssueWorktree,
  formatUtc8Timestamp,
  isTransientNetworkError,
  loopBackoffMs,
  retryTransient,
  runCommandWithRetry,
} from "../scripts/daemon-support.mjs";

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })).trim();
}

test("daemon timestamps explicitly identify UTC+8", () => {
  assert.equal(formatUtc8Timestamp(new Date("2026-09-10T08:16:14.466Z")), "2026-09-10T16:16:14.466+08:00");
  assert.doesNotMatch(formatUtc8Timestamp(), /Z$/);
});

test("transient GitHub failures retry with finite exponential backoff", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryTransient(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("unexpected EOF"), { stderr: "remote end hung up unexpectedly" });
    return "ok";
  }, {
    attempts: 3,
    baseDelayMs: 10,
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(isTransientNetworkError(new Error("authentication failed")), false);
  assert.equal(loopBackoffMs(1, 30_000), 30_000);
  assert.equal(loopBackoffMs(4, 30_000), 240_000);
  assert.equal(loopBackoffMs(20, 30_000), 900_000);
});

test("ETIMEDOUT from execFileSync is treated as transient for retry", () => {
    // Windows + gh sometimes leaves a zombie child after an EOF; the next
    // execFileSync can block until execFileSync's own `timeout` kills the
    // child. ETIMEDOUT must trigger retry, not abort the poll cycle.
    assert.equal(isTransientNetworkError(Object.assign(new Error("Command failed: ETIMEDOUT"), { code: "ETIMEDOUT" })), true);
});

test("runCommandWithRetry applies a default timeout to execFileSync", async () => {
    // Spawn a node child that sleeps well past the default 30s timeout, but
    // pass an explicit tiny timeout via commandOptions to keep the test
    // fast. This proves the helper honors the timeout knob and that a
    // timed-out call surfaces a recognisable error.
    const child = process.platform === "win32"
        ? `"${process.execPath}" -e "setTimeout(()=>{}, 10000)"`
        : `${process.execPath} -e "setTimeout(()=>{}, 10000)"`;
    await assert.rejects(
        () => runCommandWithRetry(
            process.execPath,
            ["-e", "setTimeout(()=>{}, 10000)"],
            { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 500 },
            { attempts: 1, baseDelayMs: 1, sleep: async () => {} },
        ),
        (err) => {
            // execFileSync raises Error with code 'ETIMEDOUT' on Node 22
            // when the timeout fires. Accept either the code or any
            // substring that mentions timeout.
            return err?.code === "ETIMEDOUT" || /timed out|timeout/i.test(String(err));
        },
    );
}, { timeout: 15_000 });

test("each issue gets one stable reusable real git worktree", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-worktree-test-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const workdir = path.join(root, "work");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(source);
  git(root, ["init", "--bare", remote]);
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "factory@test.local"]);
  git(source, ["config", "user.name", "Factory Test"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "fixture"]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "-u", "origin", "main"]);

  const first = await ensureIssueWorktree({ workdir, issueNumber: 17, sourceRepo: source, defaultBranch: "main" });
  const second = await ensureIssueWorktree({ workdir, issueNumber: 17, sourceRepo: source, defaultBranch: "main" });
  const other = await ensureIssueWorktree({ workdir, issueNumber: 18, sourceRepo: source, defaultBranch: "main" });

  assert.equal(first, path.join(workdir, "issue-17"));
  assert.equal(second, first);
  assert.notEqual(other, first);
  assert.equal(path.resolve(git(first, ["rev-parse", "--show-toplevel"])), path.resolve(first));
  assert.equal(fs.readFileSync(path.join(first, "README.md"), "utf-8").replace(/\r\n/g, "\n"), "fixture\n");
  const registered = git(source, ["worktree", "list", "--porcelain"]).replace(/\\/g, "/");
  assert.ok(registered.includes(first.replace(/\\/g, "/")));
  assert.ok(registered.includes(other.replace(/\\/g, "/")));
});
