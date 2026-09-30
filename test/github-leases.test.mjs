import test from "node:test";
import assert from "node:assert/strict";
import { listGitHubLeases } from "../runtime/github-leases.mjs";
import { resolveFactoryConfig } from "../runtime/factory-config.mjs";

const config = resolveFactoryConfig({ env: { FACTORY_GH_REPO: "owner/repo", GH_TOKEN: "test" } });
test("lease projection derives holder and time from GitHub without a waiter-side file", async () => {
  const client = {
    listLeaseRefs: async () => [{ issueNumber: 48, ref: "refs/heads/factory/leases/issue-48", sha: "holder" }],
    getCommitMessage: async () => "factory-lease issue=48 owner=another-host:123 ts=2026-09-30T00:00:00Z",
  };
  const [lease] = await listGitHubLeases(config, client);
  assert.equal(lease.owner, "another-host:123");
  assert.equal(lease.sha, "holder");
  assert.equal(lease.dead, false);
  assert.equal(lease.malformed, false);
});

test("wrong-issue commit metadata cannot justify automatic takeover", async () => {
  const [lease] = await listGitHubLeases(config, {
    listLeaseRefs: async () => [{ issueNumber: 48, sha: "holder" }],
    getCommitMessage: async () => "factory-lease issue=49 owner=another-host:123 ts=2026-09-30T00:00:00Z",
  });
  assert.equal(lease.malformed, true);
  assert.equal(lease.dead, false);
});

test("lease observation network failures propagate rather than claiming an empty namespace", async () => {
  await assert.rejects(listGitHubLeases(config, {
    listLeaseRefs: async () => { throw new Error("offline"); },
  }), /offline/);
});
