import test from "node:test";
import assert from "node:assert/strict";
import {
  mergePullRequest,
  prepareMergeCandidate,
  openPullRequest,
  type CommandRunner,
  type PullRequestApi,
  type RestPullRequest,
} from "../github/git.js";

/**
 * Phase B (gh-instability fix, 2026-09-17): the GitHub PR flow moved
 * from `gh pr list/create/view/merge` shell-outs to the undici REST
 * client. These tests inject a fake `PullRequestApi` and a fake
 * `CommandRunner` (git-level ops only) and assert the REST call
 * sequence replaces the legacy gh invocations 1:1.
 */

const TOKEN = "test-token";

function withToken(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = TOKEN;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
}

function makeApiRecorder(state: { prs: RestPullRequest[] }, createdPr?: RestPullRequest) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let mergeConfirmed = false;
  const api: PullRequestApi = {
    async listPullRequests(args) {
      calls.push({ method: "listPullRequests", args });
      return state.prs.map((pr) => ({ number: pr.number, html_url: pr.html_url }));
    },
    async openPullRequest(args) {
      calls.push({ method: "openPullRequest", args });
      const pr = createdPr ?? {
        number: 42,
        html_url: "https://github.com/acme/widget/pull/42",
        state: "open",
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { sha: "a".repeat(40), ref: String(args.head), repo: { full_name: "acme/widget" } },
        base: { ref: String(args.base) },
      };
      state.prs.push(pr);
      return { number: pr.number, html_url: pr.html_url };
    },
    async fetchPullRequest(args) {
      calls.push({ method: "fetchPullRequest", args });
      const base = state.prs.find((pr) => pr.number === Number(args.number));
      if (!base) throw new Error(`unexpected fetchPullRequest number: ${String(args.number)}`);
      return mergeConfirmed ? { ...base, merged: true, state: "closed", merged_at: "2026-09-02T00:00:00Z", merge_commit_sha: "b".repeat(40) } : base;
    },
    async mergePullRequest(args) {
      calls.push({ method: "mergePullRequest", args });
      mergeConfirmed = true;
      return { merged: true };
    },
    async deleteRef(args) {
      calls.push({ method: "deleteRef", args });
      return true;
    },
    async fetchGitCommit(args) {
      calls.push({ method: "fetchGitCommit", args });
      return { sha: args.sha, tree: { sha: "c".repeat(40) }, parents: [{ sha: "d".repeat(40) }, { sha: "a".repeat(40) }] };
    },
  };
  return { api, calls };
}

const OPEN_PR: RestPullRequest = {
  number: 42,
  html_url: "https://github.com/acme/widget/pull/42",
  state: "open",
  merged: false,
  merged_at: null,
  merge_commit_sha: null,
  head: { sha: "a".repeat(40), ref: "feature/issue-7", repo: { full_name: "acme/widget" } },
  base: { ref: "main", sha: "d".repeat(40) },
};

test("GitHub remote creates a PR through REST without writing hidden refs", async () => {
  await withToken(async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "remote") {
        return { stdout: "https://github.com/acme/widget.git\n", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "C:/work/widget\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const { api, calls: apiCalls } = makeApiRecorder({ prs: [] });

    const result = await openPullRequest({
      workdir: "C:/work/widget",
      remotePath: "https://github.com/acme/widget.git",
      branch: "feature/issue-7",
      baseBranch: "main",
      title: "Implement issue #7",
      body: "Closes #7",
    }, run, api);

    assert.equal(result.prNumber, 42);
    assert.equal(result.prUrl, "https://github.com/acme/widget/pull/42");
    assert.equal(result.headSha, "a".repeat(40));
    assert.equal(result.baseBranch, "main");
    const created = apiCalls.find((c) => c.method === "openPullRequest");
    assert.ok(created, "expected a REST PR creation");
    assert.equal(created.args.head, "feature/issue-7");
    assert.equal(created.args.base, "main");
    const listed = apiCalls.find((c) => c.method === "listPullRequests");
    assert.ok(listed, "expected an existing-PR lookup");
    assert.equal(listed.args.head, "acme:feature/issue-7", "list head must use owner:branch format");
    // No git-level pull refs and no gh shell-outs.
    assert.ok(!calls.some((call) => call.command !== "git"));
    assert.ok(!calls.some((call) => call.args.some((arg) => arg.includes("refs/pull/"))));
  });
});

test("existing open PR for the branch is reused instead of re-created", async () => {
  await withToken(async () => {
    const run: CommandRunner = async (command, args) => {
      if (command === "git" && args[0] === "remote") return { stdout: "https://github.com/acme/widget.git\n", stderr: "" };
      if (command === "git" && args[0] === "rev-parse") return { stdout: "C:/work/widget\n", stderr: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const { api, calls: apiCalls } = makeApiRecorder({ prs: [OPEN_PR] });

    const result = await openPullRequest({
      workdir: "C:/work/widget",
      remotePath: "https://github.com/acme/widget.git",
      branch: "feature/issue-7",
      baseBranch: "main",
      title: "Implement issue #7",
      body: "Closes #7",
    }, run, api);

    assert.equal(result.prNumber, 42);
    assert.ok(!apiCalls.some((c) => c.method === "openPullRequest"), "must not create a second PR");
  });
});

test("pull request creation never fabricates success outside a repository", async () => {
  const run: CommandRunner = async () => { throw new Error("not a repository"); };
  const { api } = makeApiRecorder({ prs: [] });
  await assert.rejects(openPullRequest({
    workdir: "C:/missing/widget",
    remotePath: "https://github.com/acme/widget.git",
    branch: "feature/issue-7",
    baseBranch: "main",
    title: "Implement issue #7",
    body: "Closes #7",
  }, run, api), /outside the target repository root/);
});

test("GitHub merge is confirmed from the remote before reporting success", async () => {
  await withToken(async () => {
    const run: CommandRunner = async (command, args) => {
      if (command === "git" && args[0] === "remote") return { stdout: "https://github.com/acme/widget.git\n", stderr: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const { api, calls: apiCalls } = makeApiRecorder({ prs: [OPEN_PR] });

    const result = await mergePullRequest({
      workdir: "C:/work/widget",
      remotePath: "https://github.com/acme/widget.git",
      prUrl: "https://github.com/acme/widget/pull/42",
      expectedHeadSha: "a".repeat(40),
      candidate: { headSha: "a".repeat(40), baseSha: "d".repeat(40), treeSha: "c".repeat(40) },
      expectedBaseBranch: 'main',
    }, run, api);

    assert.equal(result.merged, true);
    assert.equal(result.mergeCommitSha, "b".repeat(40));
    assert.equal(result.mergedAt, "2026-09-02T00:00:00Z");
    const merge = apiCalls.find((c) => c.method === "mergePullRequest");
    assert.ok(merge, "expected a REST merge call");
    assert.equal(merge.args.mergeMethod, "merge", "factory merges with a merge commit (legacy gh --merge behaviour)");
    assert.equal(merge.args.sha, "a".repeat(40), "expectedHeadSha pins the merge (legacy --match-head-commit)");
    const deleted = apiCalls.find((c) => c.method === "deleteRef");
    assert.ok(deleted, "merged feature branches should be removed from the remote");
    assert.equal(deleted.args.ref, "heads/feature/issue-7");
    assert.ok(apiCalls.findIndex(c => c.method === 'fetchGitCommit') < apiCalls.findIndex(c => c.method === 'deleteRef'));
  });
});

test("merge rejects an unparseable PR URL instead of guessing", async () => {
  await withToken(async () => {
    const run: CommandRunner = async () => ({ stdout: "https://github.com/acme/widget.git\n", stderr: "" });
    const { api } = makeApiRecorder({ prs: [OPEN_PR] });
    await assert.rejects(mergePullRequest({
      workdir: "C:/work/widget",
      remotePath: "https://github.com/acme/widget.git",
      prUrl: "not-a-url",
    }, run, api), /Cannot parse pull-request number/);
  });
});

test('implementation merge does not submit when the reviewed head, base or target branch moved', async () => {
  await withToken(async () => {
    for (const changed of [
      { ...OPEN_PR, head: { ...OPEN_PR.head, sha: 'e'.repeat(40) } },
      { ...OPEN_PR, base: { ref: 'main', sha: 'e'.repeat(40) } },
      { ...OPEN_PR, base: { ref: 'other', sha: 'd'.repeat(40) } },
    ]) {
      const { api, calls } = makeApiRecorder({ prs: [changed] });
      const run: CommandRunner = async () => ({ stdout: 'https://github.com/acme/widget.git', stderr: '' });
      await assert.rejects(mergePullRequest({ workdir: 'unused', remotePath: '', prUrl: OPEN_PR.html_url,
        expectedHeadSha: 'a'.repeat(40), expectedBaseBranch: 'main',
        candidate: { headSha: 'a'.repeat(40), baseSha: 'd'.repeat(40), treeSha: 'c'.repeat(40) },
      }, run, api), { code: 'FACTORY_MERGE_CANDIDATE_MISMATCH' });
      assert.ok(!calls.some(call => ['mergePullRequest', 'deleteRef'].includes(call.method)));
    }
  });
});

test('actual merge tree or parents mismatch retains the head branch and is not completion', async () => {
  await withToken(async () => {
    for (const commit of [
      { sha: 'b'.repeat(40), tree: { sha: 'e'.repeat(40) }, parents: [{ sha: 'd'.repeat(40) }, { sha: 'a'.repeat(40) }] },
      { sha: 'b'.repeat(40), tree: { sha: 'c'.repeat(40) }, parents: [{ sha: 'e'.repeat(40) }, { sha: 'a'.repeat(40) }] },
      { sha: 'b'.repeat(40), tree: { sha: 'c'.repeat(40) }, parents: [{ sha: 'd'.repeat(40) }] },
    ]) {
      const { api, calls } = makeApiRecorder({ prs: [OPEN_PR] });
      api.fetchGitCommit = async () => commit;
      const run: CommandRunner = async () => ({ stdout: 'https://github.com/acme/widget.git', stderr: '' });
      await assert.rejects(mergePullRequest({ workdir: 'unused', remotePath: '', prUrl: OPEN_PR.html_url,
        expectedHeadSha: 'a'.repeat(40), expectedBaseBranch: 'main',
        candidate: { headSha: 'a'.repeat(40), baseSha: 'd'.repeat(40), treeSha: 'c'.repeat(40) },
      }, run, api), { code: 'FACTORY_MERGE_CANDIDATE_MISMATCH' });
      assert.ok(calls.some(call => call.method === 'mergePullRequest'));
      assert.ok(!calls.some(call => call.method === 'deleteRef'));
    }
  });
});

test('candidate proof transfers only when the complete merge tree equals the verified head tree', async () => {
  for (const tree of ['c'.repeat(40), 'e'.repeat(40), 'conflict output']) {
    const run: CommandRunner = async (_command, args) => ({ stdout: args[0] === 'merge-tree' ? tree : 'c'.repeat(40), stderr: '' });
    const operation = prepareMergeCandidate({ workdir: 'unused', baseSha: 'd'.repeat(40), headSha: 'a'.repeat(40) }, run);
    if (tree === 'c'.repeat(40)) assert.deepEqual(await operation,
      { baseSha: 'd'.repeat(40), headSha: 'a'.repeat(40), treeSha: 'c'.repeat(40) });
    else await assert.rejects(operation, /differs from the verified head/);
  }
});

test("missing token fails fast with an actionable message", async () => {
  const previous = process.env.GH_TOKEN;
  const previous2 = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const run: CommandRunner = async (command, args) => {
      if (command === "git" && args[0] === "remote") return { stdout: "https://github.com/acme/widget.git\n", stderr: "" };
      if (command === "git" && args[0] === "rev-parse") return { stdout: "C:/work/widget\n", stderr: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const { api } = makeApiRecorder({ prs: [] });
    await assert.rejects(openPullRequest({
      workdir: "C:/work/widget",
      remotePath: "https://github.com/acme/widget.git",
      branch: "feature/issue-7",
      baseBranch: "main",
      title: "Implement issue #7",
      body: "Closes #7",
    }, run, api), /GH_TOKEN or GITHUB_TOKEN/);
  } finally {
    if (previous !== undefined) process.env.GH_TOKEN = previous;
    if (previous2 !== undefined) process.env.GITHUB_TOKEN = previous2;
  }
});
