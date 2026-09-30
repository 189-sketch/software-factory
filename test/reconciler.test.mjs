import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFactoryConfig } from "../runtime/factory-config.mjs";
import { encodeState, publicSnapshot } from "../runtime/state-codec.mjs";
import { findStaleInFlight, findStaleLeases, findOrphanWorktrees, runReconciler } from "../scripts/reconciler.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-github-reconciler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveFactoryConfig({ cwd: root, env: {
    FACTORY_GH_REPO: "owner/repo", GH_TOKEN: "test", FACTORY_STATE_WRITERS: "bot",
  } });
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const record = encodeState({ version: 1, repository: "owner/repo", issueNumber: 48,
    revision: 1, parentHash: null, snapshot: publicSnapshot({ issue: { number: 48 }, revision: 1, merged: false,
      externalOps: [
        { id: "uncertain", kind: "issue-comment", status: "unknown", updatedAt: old, idempotencyKey: "marker" },
        { id: "confirmed", kind: "label-sync", status: "succeeded", updatedAt: old },
      ],
    }) });
  const ghClient = {
    listIssues: async () => [{ number: 48, title: "Current GitHub issue", labels: [], state: "open" }],
    listIssueComments: async () => [{ author: "bot", body: record.body }],
    listLeaseRefs: async () => [{ issueNumber: 48, sha: "lease" }],
    getCommitMessage: async () => "factory-lease issue=48 owner=another-host:123 ts=2000-01-01T00:00:00Z",
  };
  return { root, config, ghClient };
}

test("reconciler reads trusted GitHub operations and ignores stale local production checkpoints", async (t) => {
  const { config, ghClient } = await fixture(t);
  await mkdir(path.join(config.paths.stateDir, "issues"), { recursive: true });
  await writeFile(path.join(config.paths.stateDir, "issues", "999.json"), "{corrupt legacy state");
  const rows = await findStaleInFlight(config, undefined, { ghClient });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issueNumber, 48);
  assert.equal(rows[0].opId, "uncertain");
});

test("GitHub stale lease observations do not silently remove a live foreign owner", async (t) => {
  const { config, ghClient } = await fixture(t);
  const [lease] = await findStaleLeases(config, undefined, { ghClient });
  assert.equal(lease.issueNumber, 48);
  assert.equal(lease.dead, false);
  assert.ok(lease.requiredAction);
});

test("orphan worktree protection comes from GitHub refs, not presence of a local checkpoint", async (t) => {
  const { config, ghClient } = await fixture(t);
  for (const number of [48, 49]) {
    const directory = path.join(config.paths.workdir, `issue-${number}`);
    await mkdir(directory, { recursive: true });
    await utimes(directory, new Date(0), new Date(0));
  }
  const rows = await findOrphanWorktrees(config, undefined, { ghClient });
  assert.deepEqual(rows.map((row) => row.issueNumber), [49]);
});

test("reconciler aggregates GitHub recovery and ownership observations", async (t) => {
  const { config, ghClient } = await fixture(t);
  const report = await runReconciler(config, { ghClient });
  assert.equal(report.inFlight.length, 1);
  assert.equal(report.staleLeases.length, 1);
  assert.equal(report.orphanWorktrees.length, 0);
});

test("GitHub outage is not mistaken for clean state", async (t) => {
  const { config, ghClient } = await fixture(t);
  ghClient.listIssues = async () => { throw new Error("network unavailable"); };
  await assert.rejects(runReconciler(config, { ghClient }), /network unavailable/);
});
