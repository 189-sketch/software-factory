// Read-only inspection and encoding reproduction using trusted real GitHub state.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { encodeState, latestStateRecord } from '../../runtime/state-codec.mjs';
import { buildStageInputManifest } from '../../src/core/stage-input-manifest.ts';

const [repository, numberText, workdir] = process.argv.slice(2);
const number = Number(numberText);
if (!repository || !Number.isSafeInteger(number) || number < 1 || !workdir) throw new Error('Usage: state-capacity-probe <repository> <issue> <checkout>');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const store = new GitHubStateStore({ repository, token, stateDir: workdir });
const { latest, comments } = await store.readRecord(number);
if (!latest) throw new Error('No trusted state exists');
const snapshot = structuredClone(latest.envelope.snapshot);
console.log(JSON.stringify({ revision: latest.envelope.revision, bytes: Buffer.byteLength(JSON.stringify(snapshot)),
  compressedBytes: deflateSync(JSON.stringify(snapshot)).length,
  fields: Object.entries(snapshot).map(([field, value]) => ({ field, bytes: Buffer.byteLength(JSON.stringify(value)),
    compressedBytes: deflateSync(JSON.stringify(value)).length })).sort((a, b) => b.bytes - a.bytes).slice(0, 8) }));
const runId = randomUUID();
const manifest = buildStageInputManifest(snapshot, 'implementation', runId, workdir);
snapshot.events ??= [];
snapshot.events.push({ stage: 'implementation', startedAt: new Date().toISOString(), status: 'running', reason: `runId=${runId}` },
  { stage: 'implementation', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: 'completed', verdict: JSON.stringify(manifest) });
snapshot.revision = latest.envelope.revision + 1;
const next = { ...latest.envelope, revision: snapshot.revision, parentHash: latest.hash, snapshot };
const record = encodeState(next);
const writers = await store.trustedWriters();
const bodies = [...(record.chunks ?? []), record.body];
const decoded = latestStateRecord([...comments, ...bodies.map(body => ({ author: writers[0], body }))], { repository, issueNumber: number, writers });
assert.deepEqual(decoded.envelope, next);
console.log(JSON.stringify({ nextRevision: next.revision, commentBytes: bodies.map(body => Buffer.byteLength(body)),
  preservedEvents: snapshot.events.length, exactRoundTrip: true, remoteWrites: 0 }));
