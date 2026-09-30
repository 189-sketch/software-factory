// Opt-in real-GitHub probe, never part of the automated offline test suite.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createLeaseManager } from "../../runtime/lease-manager.mjs";
import { GitHubStateStore } from "../../runtime/github-state-store.mjs";
import * as github from "../../runtime/github-rest.mjs";
import { writeDurableJson } from "../../runtime/durable-json.mjs";
import { STATE_MARKER } from "../../runtime/state-codec.mjs";

const [mode, numberRaw, stateDir] = process.argv.slice(2);
const number = Number(numberRaw);
if (!["crash-after-post", "resume", "lost-response"].includes(mode) || !stateDir || !Number.isSafeInteger(number) || number < 1) {
  throw new Error("Usage: github-state-crash-probe.mjs crash-after-post|resume|lost-response ISSUE STATE_DIR");
}
const repository = process.env.FACTORY_GH_REPO;
const token = process.env.GH_TOKEN;
const manager = createLeaseManager({ repository, token, stateDir, defaultBranch: "main" });
const receiptFile = path.join(stateDir, "probe-lease.json");
const options = { repository, token, stateDir };

if (mode === "lost-response") {
  const lease = await manager.acquire(number, os.hostname() + ":" + process.pid);
  if (!lease || lease.backend !== "github-ref") throw new Error("Real probe requires an exclusive GitHub lease");
  let posts = 0;
  const store = new GitHubStateStore({
    ...options, leaseSha: lease.sha,
    ghClient: { ...github, createIssueComment: async (input) => {
      posts++;
      await github.createIssueComment(input);
      throw Object.assign(new Error('Injected connection reset after real GitHub POST'), { code: 'ECONNRESET' });
    } },
  });
  try {
    const state = await store.read(number);
    state.correction = { targetStage: "implementation", turns: [{ role: "user", content: "R3 lost-response probe feedback" }] };
    await store.save(state);
    const fresh = await new GitHubStateStore({ ...options, leaseSha: lease.sha }).load(number);
    assert.equal(fresh.correction.turns[0].content, "R3 lost-response probe feedback");
    assert.equal(posts, 1);
    const records = (await github.listIssueComments({ token, repository, number })).filter((comment) => comment.body.includes(STATE_MARKER));
    assert.equal(records.length, 1);
    await assert.rejects(fs.access(path.join(stateDir, "recover", number + ".json")), { code: "ENOENT" });
    console.log('PROBE_LOST_RESPONSE_PASS: real POST confirmed by fresh GET; posts=1 records=1 journal cleared');
  } finally {
    await manager.release(lease);
  }
  process.exit(0);
}

if (mode === "crash-after-post") {
  const lease = await manager.acquire(number, os.hostname() + ":" + process.pid);
  if (!lease || lease.backend !== "github-ref") throw new Error("Real probe requires an exclusive GitHub lease");
  await writeDurableJson(receiptFile, lease);
  const store = new GitHubStateStore({
    ...options, leaseSha: lease.sha,
    ghClient: {
      ...github,
      createIssueComment: async (input) => {
        const id = await github.createIssueComment(input);
        assert.ok(id);
        console.log("PROBE_POST_CONFIRMED: " + id + "; abrupt exit before journal settlement");
        process.exit(75);
      },
    },
  });
  const existing = await store.load(number);
  const state = existing ?? { issue: { number }, merged: false, status: "waiting" };
  state.correction = { targetStage: "implementation", turns: [{ role: "user", content: "R3 crash probe feedback preserved" }] };
  state.providerSessions = { implementation: { providerSessionId: "must-remain-private" } };
  await store.save(state);
  throw new Error("Crash injection did not execute");
}

const lease = JSON.parse(await fs.readFile(receiptFile, "utf8"));
assert.equal(lease.issueNumber, number);
const store = new GitHubStateStore({ ...options, leaseSha: lease.sha });
try {
  const result = await store.recover(number);
  assert.equal(result.recovered, true);
  const state = await store.load(number);
  assert.equal(state.correction.turns[0].content, "R3 crash probe feedback preserved");
  assert.equal(state.providerSessions, undefined);
  const comments = await github.listIssueComments({ token, repository, number });
  const records = comments.filter((comment) => comment.body.includes(STATE_MARKER));
  assert.equal(records.length, 1);
  await assert.rejects(fs.access(path.join(stateDir, "recover", number + ".json")), { code: "ENOENT" });
  console.log("PROBE_RECOVERY_PASS: revision=" + state.revision + " comments=" + records.length + " no duplicate POST, no public session");
} finally {
  await manager.release(lease);
  console.log("PROBE_LEASE_RELEASED");
}
