import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { GitHubStateStore } from "../runtime/github-state-store.mjs";
import { encodeState, decodeStateComment, latestStateRecord, publicSnapshot } from "../runtime/state-codec.mjs";

const repository = "owner/project";
function state() {
  return {
    issue: { number: 48, title: "Login", comments: [{ body: "do not copy the thread" }] },
    merged: false, status: "waiting", nextLabel: "needs-info",
    providerSessions: { implementation: { providerSessionId: "private-session" } },
    correction: { turns: [{ content: "Fix AC-3" }] },
  };
}
function record(revision = 1, parentHash = null, input = state()) {
  return encodeState({ version: 1, repository, issueNumber: 48, revision, parentHash,
    snapshot: publicSnapshot({ ...input, revision }) });
}
const decodeOptions = { repository, issueNumber: 48, writers: ["factory-bot"] };

test("codec preserves revision feedback but excludes sessions, credentials, and thread copies", () => {
  const input = state();
  input.error = "Authorization: Bearer example-secret ghp_example123";
  input.token = "private-token";
  const encoded = record(1, null, input);
  const decoded = decodeStateComment({ author: "factory-bot", body: encoded.body }, decodeOptions);
  assert.equal(decoded.envelope.snapshot.correction.turns[0].content, "Fix AC-3");
  assert.deepEqual(decoded.envelope.snapshot.issue, { number: 48 });
  assert.ok(!JSON.stringify(decoded).includes("private-session"));
  assert.ok(!JSON.stringify(decoded).includes("private-token"));
  assert.ok(!JSON.stringify(decoded).includes("example-secret"));
});

test("untrusted marker text cannot create a resume point", () => {
  assert.equal(decodeStateComment({ author: "stranger", body: record().body }, decodeOptions), null);
  assert.equal(latestStateRecord([{ author: "stranger", body: record().body }], decodeOptions), null);
});

test("codec rejects wrong issue, corrupted payload, private fields, and oversized records", () => {
  const encoded = record();
  assert.throws(() => decodeStateComment({ author: "factory-bot", body: encoded.body }, { ...decodeOptions, issueNumber: 49 }), /mismatch/);
  assert.throws(() => decodeStateComment({ author: "factory-bot", body: encoded.body.replace(encoded.hash, "0".repeat(64)) }, decodeOptions), /checksum/);
  assert.throws(() => encodeState({ ...encoded.envelope, snapshot: { ...encoded.envelope.snapshot, providerSessions: {} } }), /private/);
  assert.throws(() => record(1, null, { ...state(), error: "x".repeat(600_000) }), /decoded size/);
  assert.throws(() => record(1, null, { ...state(), error: randomBytes(80_000).toString("base64") }), /comment size/);
});

test("revision chain accepts duplicate posts but rejects forks and missing parents", () => {
  const first = record();
  const second = record(2, first.hash);
  const comment = (entry) => ({ author: "factory-bot", body: entry.body });
  assert.equal(latestStateRecord([comment(first), comment(first), comment(second)], decodeOptions).hash, second.hash);
  assert.throws(() => latestStateRecord([comment(second)], decodeOptions), /missing parent/);
  assert.throws(() => latestStateRecord([comment(first), comment(record(1, null, { ...state(), attempts: 2 }))], decodeOptions), /revision conflict/);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-github-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const comments = [];
  let leaseSha = "lease-sha";
  let mode = "ok";
  const ghClient = {
    fetchAuthenticatedUser: async () => ({ login: "factory-bot" }),
    getRef: async () => leaseSha,
    fetchIssue: async () => ({
      number: 48, title: "Current GitHub title", body: "Current requirement",
      labels: [{ name: "ready-to-implement" }], author: { login: "owner" },
    }),
    listIssueComments: async () => {
      if (mode === "offline") throw new Error("network offline");
      return comments;
    },
    createIssueComment: async ({ body, maxRetries }) => {
      assert.equal(maxRetries, 0);
      if (mode === "post-failed" || mode === "offline") throw new Error("POST unavailable");
      comments.push({ id: comments.length + 1, author: "factory-bot", body });
      if (mode === "lost-response") throw new Error("POST response lost");
      return comments.length;
    },
  };
  const options = { repository, token: "secret", stateDir: directory, leaseSha, ghClient };
  return {
    store: new GitHubStateStore(options), options, directory, comments,
    setMode(value) { mode = value; }, setLease(value) { leaseSha = value; },
  };
}

test("save reloads from GitHub after restart and removes its upload journal", async (t) => {
  const f = await fixture(t);
  const input = state();
  await f.store.save(input);
  assert.equal(input.revision, 1);
  const loaded = await new GitHubStateStore(f.options).load(48);
  assert.equal(loaded.issue.title, "Current GitHub title");
  assert.deepEqual(loaded.issue.labels, ["ready-to-implement"]);
  assert.equal(loaded.issue.comments.length, 0);
  assert.equal(loaded.correction.turns[0].content, "Fix AC-3");
  assert.equal(loaded.providerSessions, undefined);
  await assert.rejects(access(path.join(f.directory, "recover", "48.json")), { code: "ENOENT" });
});

test("write refuses absent or lost lease without posting or creating a journal", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new GitHubStateStore({ ...f.options, leaseSha: "" }).save(state()), /acquire a GitHub/);
  f.setLease("another-owner");
  await assert.rejects(f.store.save(state()), /lease was lost/);
  assert.equal(f.comments.length, 0);
  await assert.rejects(access(path.join(f.directory, "recover", "48.json")), { code: "ENOENT" });
});

test("stale writer revisions cannot overwrite the latest remote state", async (t) => {
  const f = await fixture(t);
  await f.store.save(state());
  await assert.rejects(new GitHubStateStore(f.options).save(state()), /revision changed/);
  assert.equal(f.comments.length, 1);
});

test("lost POST response is reconciled without a duplicate retry", async (t) => {
  const f = await fixture(t);
  f.setMode("lost-response");
  const input = state();
  await f.store.save(input);
  assert.equal(input.revision, 1);
  assert.equal(f.comments.length, 1);
  await assert.rejects(access(path.join(f.directory, "recover", "48.json")), { code: "ENOENT" });
});

test("failed POST keeps durable recovery, blocks side effects, and resumes in a new process", async (t) => {
  const f = await fixture(t);
  f.setMode("post-failed");
  await assert.rejects(f.store.save(state()), { code: "FACTORY_STATE_UPLOAD_PENDING" });
  const pending = JSON.parse(await readFile(path.join(f.directory, "recover", "48.json"), "utf8"));
  assert.equal(pending.envelope.revision, 1);
  assert.ok(!JSON.stringify(pending).includes("private-session"));
  await assert.rejects(f.store.save(state()), /恢复记录尚未上传/);
  f.setMode("ok");
  const restarted = new GitHubStateStore(f.options);
  assert.deepEqual(await restarted.recover(48), { recovered: true, revision: 1 });
  assert.equal((await restarted.load(48)).revision, 1);
  assert.equal(f.comments.length, 1);
});

test("offline reads never promote the local upload journal into authority", async (t) => {
  const f = await fixture(t);
  f.setMode("offline");
  await assert.rejects(f.store.load(48), /offline/);
  assert.equal(f.comments.length, 0);
});

test("recovery refuses divergence from a newer remote revision", async (t) => {
  const f = await fixture(t);
  f.setMode("post-failed");
  await assert.rejects(f.store.save(state()), { code: "FACTORY_STATE_UPLOAD_PENDING" });
  f.setMode("ok");
  f.comments.push({ author: "factory-bot", body: record(1, null, { ...state(), attempts: 5 }).body });
  await assert.rejects(new GitHubStateStore(f.options).recover(48), /新版本冲突/);
  assert.equal(f.comments.length, 1);
  await access(path.join(f.directory, "recover", "48.json"));
});
