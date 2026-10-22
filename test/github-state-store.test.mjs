import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import ts from "typescript";
import { GitHubStateStore } from "../runtime/github-state-store.mjs";
import { encodeState, decodeStateComment, latestStateRecord, publicSnapshot } from "../runtime/state-codec.mjs";
import { agentRuntimeRecoveryStage } from "../runtime/agent-recovery.mjs";
import { shouldParkWaitingIssue } from "../scripts/daemon-support.mjs";

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

test('technical specification repair ownership survives trusted checkpoint encoding', () => {
  const input = { ...state(), specificationRepair: { sourceSpecSha: 'approved-spec', findingIds: ['technical-fact'] } };
  const encoded = record(1, null, input);
  const restored = decodeStateComment({ id: 1, author: 'bot', body: encoded.body },
    { repository, issueNumber: 48, writers: ['bot'] });
  assert.deepEqual(restored.envelope.snapshot.specificationRepair, input.specificationRepair);
  assert.equal(restored.envelope.snapshot.providerSessions, undefined);
});
const decodeOptions = { repository, issueNumber: 48, writers: ["factory-bot"] };

test('exact merge candidate survives trusted recovery without granting completion or discarding old checkpoints', () => {
  const candidate = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40) };
  const input = { ...state(), mergeCandidate: candidate };
  const decoded = decodeStateComment({ author: 'factory-bot', body: record(1, null, input).body }, decodeOptions);
  assert.deepEqual(decoded.envelope.snapshot.mergeCandidate, candidate);
  assert.equal(decoded.envelope.snapshot.merged, false);
  assert.equal(decoded.envelope.snapshot.status, 'waiting');
  const legacy = decodeStateComment({ author: 'factory-bot', body: record().body }, decodeOptions);
  assert.equal(legacy.envelope.snapshot.mergeCandidate, undefined, 'Old checkpoints stay readable without inventing a candidate');
  assert.equal(decodeStateComment({ author: 'stranger', body: record(1, null, input).body }, decodeOptions), null);
});

test('original generated review and judgment input binding survive trusted recovery independently of applied grades', () => {
  const generatedReview = { verdict: 'APPROVE', body: 'Original observations', comments: [], findings: [],
    origin: 'claude-code', specCommitSha: 'a'.repeat(40) };
  const input = { ...state(), review: { verdict: 'REJECT', body: 'Adjusted observations', comments: [], findings: [],
    generatedReview, judgmentInputHash: 'd'.repeat(64) } };
  const decoded = decodeStateComment({ author: 'factory-bot', body: record(1, null, input).body }, decodeOptions);
  assert.deepEqual(decoded.envelope.snapshot.review.generatedReview, generatedReview);
  assert.equal(decoded.envelope.snapshot.review.verdict, 'REJECT');
  assert.equal(decoded.envelope.snapshot.review.judgmentInputHash, input.review.judgmentInputHash);
});

test('independent validation provenance survives a trusted recovery round-trip', () => {
  const projectValidation = { baselineSha: 'a'.repeat(40), primaryLanguage: 'python',
    checks: [{ program: 'python', args: ['-m', 'unittest'], cwd: 'service', source: '.github/workflows/check.yml:jobs.quality.steps[0]' }],
    sources: [{ path: 'uv.lock', blobSha: 'b'.repeat(40), kind: 'lockfile' }],
    ciJobs: [{ source: '.github/workflows/check.yml:jobs.quality', trigger: ['pull_request'],
      runner: '${{ matrix.os }}', matrix: { os: ['ubuntu-latest', 'windows-latest'] },
      runtimes: [{ program: 'python', version: '3.12', source: 'setup' }],
      steps: [{ source: 'check', cwd: 'service', shell: 'bash',
        condition: { job: null, step: 'always()' }, continueOnError: { job: false, step: false } }] }],
    notes: ['local projection, not full CI matrix'], blockers: [] };
  const input = { ...state(), implementation: { projectValidation } };
  const decoded = decodeStateComment({ author: 'factory-bot', body: record(1, null, input).body }, decodeOptions);
  assert.deepEqual(decoded.envelope.snapshot.implementation.projectValidation, projectValidation);
});

test('verification recovery ownership and no-progress budget survive trusted checkpoint round-trip', () => {
  const input = { ...state(), verificationRecovery: { context: 'a'.repeat(64), attempts: 2, coveredRequirementIds: ['AC-1'] },
    implementation: { behaviorVerification: { status: 'not-verified', failure: { kind: 'evidence', runId: 'run',
      receiptIds: [], requirementIds: [], reason: 'No supporting assertion' } } } };
  const decoded = decodeStateComment({ author: 'factory-bot', body: record(1, null, input).body }, decodeOptions);
  assert.deepEqual(decoded.envelope.snapshot.verificationRecovery, input.verificationRecovery);
  assert.deepEqual(decoded.envelope.snapshot.implementation.behaviorVerification.failure, input.implementation.behaviorVerification.failure);
});

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

test("codec rejects wrong issue, corrupted payload, private fields, and decoded size overflow", () => {
  const encoded = record();
  assert.throws(() => decodeStateComment({ author: "factory-bot", body: encoded.body }, { ...decodeOptions, issueNumber: 49 }), /mismatch/);
  assert.throws(() => decodeStateComment({ author: "factory-bot", body: encoded.body.replace(encoded.hash, "0".repeat(64)) }, decodeOptions), /checksum/);
  assert.throws(() => encodeState({ ...encoded.envelope, snapshot: { ...encoded.envelope.snapshot, providerSessions: {} } }), /private/);
  assert.throws(() => record(1, null, { ...state(), error: "x".repeat(600_000) }), /decoded size/);
});

test('large recovery state round-trips losslessly through bounded trusted fragments and a final commit', () => {
  const encoded = record(1, null, { ...state(), error: randomBytes(80000).toString('base64') });
  assert.ok(encoded.chunks.length >= 2);
  const row = body => ({ author: 'factory-bot', body });
  const fragments = encoded.chunks.map(row);
  for (const body of [...encoded.chunks, encoded.body]) assert.ok(Buffer.byteLength(body) <= 60000);
  assert.equal(latestStateRecord(fragments, decodeOptions), null, 'Uncommitted fragments cannot advance the checkpoint');
  const comments = [...fragments, row(encoded.body)];
  assert.deepEqual(latestStateRecord(comments, decodeOptions).envelope, encoded.envelope);
  assert.deepEqual(latestStateRecord([...comments, fragments[0]], decodeOptions).envelope, encoded.envelope);
  assert.throws(() => latestStateRecord([row(encoded.body)], decodeOptions), /missing trusted fragments/);
  assert.throws(() => latestStateRecord([...fragments.slice(1), { ...fragments[0], author: 'stranger' }, row(encoded.body)], decodeOptions), /missing trusted fragments/);
  const conflicting = row(encoded.chunks[0].replace(/([A-Za-z0-9+/=]) -->$/, '$1A -->'));
  assert.throws(() => latestStateRecord([...comments, conflicting], decodeOptions), /fragment conflict/);
  assert.throws(() => latestStateRecord([row(encoded.body.replace(/chunks:[0-9]+/, 'chunks:17'))], decodeOptions), /fragment count/);
  assert.throws(() => latestStateRecord([...fragments.slice(1), conflicting, row(encoded.body)], decodeOptions));
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
  let stateSha = null;
  const commits = new Map();
  const blobs = new Map();
  const ghClient = {
    fetchAuthenticatedUser: async () => ({ login: "factory-bot" }),
    getRef: async ({ ref }) => ref.startsWith('heads/factory/state/') ? stateSha : leaseSha,
    createGitTree: async ({ tree }) => {
      const sha = (blobs.size + 1).toString(16).padStart(40, '0');
      blobs.set(sha, tree[0].content);
      return { sha: 'state-tree-' + blobs.size, tree: [{ path: 'state.json', sha }] };
    },
    fetchGitBlob: async ({ sha }) => ({ content: Buffer.from(blobs.get(sha)).toString('base64'), encoding: 'base64', size: Buffer.byteLength(blobs.get(sha)) }),
    fetchGitCommit: async ({ sha }) => commits.get(sha),
    createCommit: async ({ message, tree, parents }) => {
      assert.ok(Buffer.byteLength(message) < 65536, 'GitHub truncates large commit messages; store recovery content in a blob');
      if (mode === 'post-failed' || mode === 'offline' || mode === 'partial-fragments') throw new Error('State upload unavailable');
      const sha = `state-${commits.size + 1}`;
      commits.set(sha, { sha, message, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) });
      return { sha };
    },
    createRef: async ({ sha }) => {
      if (stateSha) throw new Error('State ref exists');
      stateSha = sha;
      if (mode === 'lost-response') throw new Error('Ref response lost');
    },
    updateRef: async ({ sha, force }) => {
      assert.equal(force, false);
      assert.equal(commits.get(sha).parents[0]?.sha, stateSha);
      stateSha = sha;
      if (mode === 'lost-response') throw new Error('Ref response lost');
    },
    fetchIssue: async () => ({
      number: 48, title: "Current GitHub title", body: "Current requirement",
      labels: [{ name: "ready-to-implement" }], author: { login: "owner" },
    }),
    listIssueComments: async () => {
      if (mode === "offline") throw new Error("network offline");
      return comments;
    },
    createIssueComment: async () => assert.fail('Recovery storage must not post Issue comments'),
  };
  const options = { repository, token: "secret", stateDir: directory, leaseSha, ghClient };
  return {
    store: new GitHubStateStore(options), options, directory, comments, commits, blobs,
    setMode(value) { mode = value; }, setLease(value) { leaseSha = value; },
  };
}

test('state saves and restart recovery use an independent ref without posting Issue comments', async t => {
  const f = await fixture(t);
  const input = state();
  await f.store.save(input);
  input.attempts = 2;
  await f.store.save(input);
  assert.equal(f.comments.length, 0);
  const restarted = new GitHubStateStore(f.options);
  assert.equal((await restarted.load(48)).attempts, 2);
  assert.deepEqual((await restarted.history(48)).map(x => x.envelope.revision), [1, 2]);
});

test('checkpoint codec covers every current public state field', async () => {
  const source = ts.createSourceFile('types.ts', await readFile(new URL('../src/core/types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'FactoryIssueState');
  assert.ok(declaration);
  const excluded = new Set(['issue', 'providerSessions', 'parseFailureHeals']); // Thread copy, private local sessions, retired counter.
  const fields = declaration.members.map(member => member.name?.getText(source)).filter(name => !excluded.has(name));
  const snapshot = publicSnapshot(Object.fromEntries(fields.map(name => [name, 'persisted'])));
  assert.deepEqual(Object.keys(snapshot).filter(name => name !== 'issue').sort(), fields.sort(), 'New public state fields must survive the real persistence codec');
});

test('executor ownership and exact command diagnostics survive ref publication and a fresh store', async t => {
  const f = await fixture(t);
  f.options.ghClient.fetchIssue = async () => ({ number: 48, state: 'open', author: 'owner', labels: ['needs-info'] });
  const input = { ...state(), agentRuntimeFailure: { stage: 'verify', code: 'FACTORY_AGENT_CONTEXT_EXHAUSTED',
    message: 'Prompt is too long', at: '2026-10-09T07:00:00Z' },
    validationFailure: { ok: false, command: 'npm test', exitCode: -1, timedOut: true, timeoutMs: 600000,
      stdout: 'Last completed test', stderr: 'Command timed out', cwd: 'worktree', profile: 'test' } };
  await f.store.save(input);
  const restored = await new GitHubStateStore(f.options).load(48);
  assert.deepEqual(restored.agentRuntimeFailure, input.agentRuntimeFailure);
  assert.deepEqual(restored.validationFailure, input.validationFailure);
  assert.equal(agentRuntimeRecoveryStage(restored), 'verify');
  assert.equal(shouldParkWaitingIssue({ checkpoint: restored, factoryLabels: ['needs-info'], unchanged: true }), false,
    'A restart must not park the recoverable executor fault as a product question');
  assert.equal(restored.providerSessions, undefined, 'Provider conversations remain in the private session store');
});

test('a completed result survives a lease-read outage before upload and recovers after restart', async t => {
  const f = await fixture(t);
  await f.store.save(state());
  const input = await f.store.load(48);
  input.implementation = { commitSha: 'a'.repeat(40), behaviorVerification: {
    status: 'verified', notes: 'Completed expensive acceptance run', checks: [{ id: 'AC-1', status: 'passed' }],
  } };
  const getRef = f.options.ghClient.getRef;
  f.options.ghClient.getRef = async () => { throw new Error('Connection timeout before headers'); };
  await assert.rejects(f.store.save(input));
  const file = path.join(f.directory, 'recover', '48.json');
  const pending = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(pending.envelope.snapshot.implementation, input.implementation);
  assert.equal(input.revision, 1, 'Unconfirmed local results cannot advance authoritative revision');
  await assert.rejects(f.store.save({ ...input, error: 'Must not replace pending results' }), /恢复记录尚未上传/);
  f.options.ghClient.getRef = getRef;
  const restarted = new GitHubStateStore(f.options);
  assert.deepEqual(await restarted.recover(48), { recovered: true, revision: 2 });
  assert.deepEqual((await restarted.load(48)).implementation, input.implementation);
  assert.deepEqual(await restarted.recover(48), { recovered: false });
  assert.equal(f.commits.size, 2, 'Recovery publishes the result exactly once');
});

test('a locally prepared result never overwrites a newer remote revision or a lost lease', async t => {
  const f = await fixture(t);
  const input = state();
  await f.store.save(input);
  const other = new GitHubStateStore({ ...f.options, stateDir: path.join(f.directory, 'other') });
  const competing = await other.load(48);
  competing.attempts = 9;
  await other.save(competing);
  input.attempts = 2;
  await assert.rejects(f.store.save(input));
  await assert.rejects(f.store.recover(48), /新版本冲突/);
  assert.equal((await other.load(48)).attempts, 9);
  f.setLease('new-owner');
  await assert.rejects(f.store.recover(48));
  assert.equal((await other.load(48)).attempts, 9);
});

test('mutating a loaded nested result cannot mutate its validated parent or suppress a save', async t => {
  const f = await fixture(t);
  const input = { ...state(), implementation: { behaviorVerification: { status: 'not-verified', checks: [] } } };
  await f.store.save(input);
  const loaded = await f.store.load(48);
  loaded.implementation.behaviorVerification.status = 'verified';
  await f.store.save(loaded);
  assert.equal(loaded.revision, 2);
  assert.equal((await new GitHubStateStore(f.options).load(48)).implementation.behaviorVerification.status, 'verified');
  const history = await f.store.history(48);
  assert.equal(history[0].envelope.snapshot.implementation.behaviorVerification.status, 'not-verified');
  f.setLease('other-owner');
  await assert.rejects(f.store.save(loaded), /lease was lost/, 'Even unchanged saves require a live lease');
});

test('large state commit upload resumes after a crash without discarding prior authority', async t => {
  const f = await fixture(t);
  const input = state();
  await f.store.save(input);
  input.error = randomBytes(80000).toString('base64');
  f.setMode('partial-fragments');
  await assert.rejects(f.store.save(input), /恢复记录未确认/);
  assert.equal((await new GitHubStateStore(f.options).load(48)).revision, 1);
  assert.equal(f.comments.length, 0);
  const restarted = new GitHubStateStore(f.options);
  f.setMode('ok');
  assert.equal((await restarted.recover(48)).revision, 2);
  assert.equal(f.comments.length, 0);
  assert.equal((await restarted.history(48)).length, 2);
  const loaded = await restarted.load(48);
  assert.equal(loaded.error, input.error);
  assert.equal(loaded.issue.comments.length, 0);
  await assert.rejects(access(path.join(f.directory, 'recover', '48.json')), { code: 'ENOENT' });
});

test('fragment and commit response loss is reconciled exactly once through trusted remote observations', async t => {
  const f = await fixture(t);
  f.setMode('lost-response');
  const input = { ...state(), error: randomBytes(80000).toString('base64') };
  await f.store.save(input);
  assert.equal(input.revision, 1);
  assert.equal((await f.store.load(48)).error, input.error);
  assert.equal(new Set(f.comments.map(row => row.body)).size, f.comments.length);
});

test('tampered fragment journals are rejected before any recovery publication', async t => {
  const f = await fixture(t);
  f.setMode('post-failed');
  await assert.rejects(f.store.save({ ...state(), error: randomBytes(80000).toString('base64') }));
  const file = path.join(f.directory, 'recover', '48.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  journal.chunks[0] += 'tampered';
  await writeFile(file, JSON.stringify(journal));
  f.setMode('ok');
  await assert.rejects(new GitHubStateStore(f.options).recover(48), /Invalid factory recovery journal/);
  assert.equal(f.comments.length, 0);
});

test('lease loss after commit creation prevents advancing the state ref', async t => {
  const f = await fixture(t);
  const input = state();
  await f.store.save(input);
  const create = f.options.ghClient.createCommit;
  f.options.ghClient.createCommit = async request => {
    const commit = await create(request);
    f.setLease('new-owner');
    return commit;
  };
  input.error = randomBytes(80000).toString('base64');
  await assert.rejects(f.store.save(input));
  assert.equal((await f.store.load(48)).revision, 1);
  assert.equal(f.comments.length, 0);
  await access(path.join(f.directory, 'recover', '48.json'));
});

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
  assert.equal(f.comments.length, 0);
});

test("lost POST response is reconciled without a duplicate retry", async (t) => {
  const f = await fixture(t);
  f.setMode("lost-response");
  const input = state();
  await f.store.save(input);
  assert.equal(input.revision, 1);
  assert.equal(f.comments.length, 0);
  assert.equal(f.commits.size, 1);
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
  assert.equal(f.comments.length, 0);
});

test('legacy comments remain unchanged while new revisions use the state ref', async t => {
  const f = await fixture(t);
  f.comments.push({ id: 1, author: 'factory-bot', body: record().body });
  f.comments.push({ id: 2, author: 'owner', body: 'Please keep the existing behavior.' });
  const before = structuredClone(f.comments);
  const input = await f.store.load(48);
  input.attempts = 3;
  await f.store.save(input);
  const restarted = new GitHubStateStore(f.options);
  assert.equal((await restarted.load(48)).attempts, 3);
  assert.deepEqual((await restarted.history(48)).map(x => x.envelope.revision), [1, 2]);
  assert.deepEqual(f.comments, before);
  assert.deepEqual((await restarted.load(48)).issue.comments.map(x => x.body), ['Please keep the existing behavior.']);
});

test('legacy writes after migration are rejected instead of silently choosing a conflicting authority', async t => {
  const f = await fixture(t);
  const first = record();
  f.comments.push({ author: 'factory-bot', body: first.body });
  const input = await f.store.load(48);
  input.attempts = 2;
  await f.store.save(input);
  f.comments.push({ author: 'factory-bot', body: record(2, first.hash, { ...state(), attempts: 99 }).body });
  await assert.rejects(new GitHubStateStore(f.options).load(48), /legacy state changed/);
});

test("offline reads never promote the local upload journal into authority", async (t) => {
  const f = await fixture(t);
  f.setMode("offline");
  await assert.rejects(f.store.load(48), /offline/);
  assert.equal(f.comments.length, 0);
});

test('state ref outages and wrong-issue payloads fail closed', async t => {
  const f = await fixture(t);
  await f.store.save(state());
  const getRef = f.options.ghClient.getRef;
  f.options.ghClient.getRef = async request => {
    if (request.ref.startsWith('heads/factory/state/')) throw new Error('State ref unavailable');
    return getRef(request);
  };
  await assert.rejects(new GitHubStateStore(f.options).load(48), /State ref unavailable/);
  f.options.ghClient.getRef = getRef;
  const commit = f.commits.values().next().value;
  const envelope = record().envelope;
  const wrong = encodeState({ ...envelope, issueNumber: 49, snapshot: { ...envelope.snapshot, issue: { number: 49 } } });
  const { blobSha } = JSON.parse(commit.message.split('\n')[1]);
  f.blobs.set(blobSha, JSON.stringify({ body: wrong.body, chunks: [], legacyHash: null }));
  await assert.rejects(new GitHubStateStore(f.options).load(48), /mismatch/);
  assert.equal(f.comments.length, 0);
});

test('a competing ref update cannot be overwritten or recovered over', async t => {
  const f = await fixture(t);
  const input = state();
  await f.store.save(input);
  const competing = await new GitHubStateStore(f.options).load(48);
  competing.attempts = 7;
  const update = f.options.ghClient.updateRef;
  f.options.ghClient.updateRef = async request => {
    f.options.ghClient.updateRef = update;
    const otherDirectory = path.join(f.directory, 'competing');
    await new GitHubStateStore({ ...f.options, stateDir: otherDirectory }).save(competing);
    return update(request);
  };
  input.attempts = 2;
  await assert.rejects(f.store.save(input), { code: 'FACTORY_STATE_UPLOAD_PENDING' });
  assert.equal((await new GitHubStateStore(f.options).load(48)).attempts, 7);
  await assert.rejects(new GitHubStateStore(f.options).recover(48), /新版本冲突/);
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
