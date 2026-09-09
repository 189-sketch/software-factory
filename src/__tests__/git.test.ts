import test from "node:test";
import assert from "node:assert/strict";
import { mergePullRequest, openPullRequest, type CommandRunner } from "../github/git.js";

test("GitHub remote creates a PR through gh without writing hidden refs", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "git" && args[0] === "remote") {
      return { stdout: "https://github.com/acme/widget.git\n", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { stdout: "C:/work/widget\n", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return { stdout: "[]\n", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return { stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({ number: 42, url: "https://github.com/acme/widget/pull/42", headRefOid: "a".repeat(40), baseRefName: "main" }),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const result = await openPullRequest({
    workdir: "C:/work/widget",
    remotePath: "https://github.com/acme/widget.git",
    branch: "feature/issue-7",
    baseBranch: "main",
    title: "Implement issue #7",
    body: "Closes #7",
  }, run);

  assert.equal(result.prNumber, 42);
  assert.equal(result.prUrl, "https://github.com/acme/widget/pull/42");
  assert.ok(calls.some((call) => call.command === "gh" && call.args.slice(0, 2).join(" ") === "pr create"));
  assert.ok(!calls.some((call) => call.command === "git" && call.args.some((arg) => arg.includes("refs/pull/"))));
});

test("pull request creation never fabricates success outside a repository", async () => {
  const run: CommandRunner = async () => { throw new Error("not a repository"); };
  await assert.rejects(openPullRequest({
    workdir: "C:/missing/widget",
    remotePath: "https://github.com/acme/widget.git",
    branch: "feature/issue-7",
    baseBranch: "main",
    title: "Implement issue #7",
    body: "Closes #7",
  }, run), /outside the target repository root/);
});

test("GitHub merge is confirmed from the remote before reporting success", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let viewCount = 0;
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "git") {
      return { stdout: "https://github.com/acme/widget.git\n", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
      return { stdout: "", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      viewCount += 1;
      return viewCount === 1
        ? { stdout: JSON.stringify({ state: "OPEN", mergedAt: null, mergeCommit: null }), stderr: "" }
        : { stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-09-02T00:00:00Z", mergeCommit: { oid: "b".repeat(40) } }), stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const result = await mergePullRequest({
    workdir: "C:/work/widget",
    remotePath: "https://github.com/acme/widget.git",
    prUrl: "https://github.com/acme/widget/pull/42",
    expectedHeadSha: "a".repeat(40),
  }, run);

  assert.equal(result.merged, true);
  assert.equal(result.mergeCommitSha, "b".repeat(40));
  const mergeCall = calls.find((call) => call.command === "gh" && call.args.slice(0, 2).join(" ") === "pr merge");
  assert.ok(mergeCall);
  assert.ok(mergeCall.args.includes("--delete-branch"), "merged feature branches should be removed from the remote");
  assert.deepEqual(mergeCall.args.slice(mergeCall.args.indexOf("--match-head-commit"), mergeCall.args.indexOf("--match-head-commit") + 2), ["--match-head-commit", "a".repeat(40)]);
});
