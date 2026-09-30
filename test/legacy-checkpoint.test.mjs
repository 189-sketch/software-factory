import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectLegacyCheckpoint } from "../runtime/legacy-checkpoint.mjs";
import { encodeState, publicSnapshot } from "../runtime/state-codec.mjs";

async function fixture(t, patch = {}, comments = []) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "factory-legacy-inspect-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const file = path.join(stateDir, "48.json");
  await writeFile(file, JSON.stringify({ issue: { number: 48 }, merged: false,
    nextLabel: "needs-info", providerSessions: { triage: "private" }, ...patch }));
  const original = await readFile(file, "utf8");
  const options = { file, stateDir, repository: "owner/repo", token: "test", number: 48,
    writers: ["bot"], ghClient: {
      fetchIssue: async () => ({ number: 48, state: "open", labels: [{ name: "needs-info" }] }),
      listIssueComments: async () => comments,
      createIssueComment: async () => { throw new Error("Read-only migration must not POST"); },
    } };
  return { options, original, file };
}

test("eligible legacy preflight is read-only and excludes sessions", async (t) => {
  const { options, original, file } = await fixture(t);
  const report = await inspectLegacyCheckpoint(options);
  assert.equal(report.eligible, true);
  assert.equal(report.authority, "github");
  assert.equal(report.candidate.revision, 1);
  assert.ok(!JSON.stringify(report.candidate).includes("private"));
  assert.equal(await readFile(file, "utf8"), original);
});

test("remote recovery always wins over legacy checkpoint", async (t) => {
  const record = encodeState({ version: 1, repository: "owner/repo", issueNumber: 48,
    revision: 1, parentHash: null, snapshot: publicSnapshot({ issue: { number: 48 }, revision: 1, merged: false }) });
  const { options } = await fixture(t, {}, [{ author: "bot", body: record.body }]);
  const report = await inspectLegacyCheckpoint(options);
  assert.equal(report.eligible, false);
  assert.equal(report.github.revision, 1);
  assert.equal(report.candidate, undefined);
});

test("label drift, unconfirmed operation, or pending label blocks migration", async (t) => {
  const { options, original, file } = await fixture(t, { nextLabel: "ready-to-implement", labelPending: true,
    externalOps: [{ status: "in-flight" }] });
  const report = await inspectLegacyCheckpoint(options);
  assert.equal(report.conflicts.length, 3);
  assert.equal(report.candidate, undefined);
  assert.equal(await readFile(file, "utf8"), original);
});

test("closed issue and local unfinished progress cannot resume execution", async (t) => {
  const { options } = await fixture(t);
  options.ghClient.fetchIssue = async () => ({ number: 48, state: "closed", labels: [{ name: "needs-info" }] });
  assert.equal((await inspectLegacyCheckpoint(options)).eligible, false);
});

test("network failure and wrong issue fail closed, not as empty GitHub state", async (t) => {
  const { options } = await fixture(t);
  options.ghClient.listIssueComments = async () => { throw new Error("network unavailable"); };
  await assert.rejects(inspectLegacyCheckpoint(options), /network unavailable/);
  await assert.rejects(inspectLegacyCheckpoint({ ...options, number: 49 }), /issue mismatch/);
});
