// Opt-in real-GitHub interruption test. Only use a dedicated disposable issue.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createLeaseManager } from '../../runtime/lease-manager.mjs';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { writeDurableJson } from '../../runtime/durable-json.mjs';
import * as github from '../../runtime/github-rest.mjs';
import { runExternalOp } from '../../src/core/external-op-ledger.ts';
import { recoverExternalOps } from '../../src/core/external-op-recovery.ts';

const [mode, issueRaw, stateDir] = process.argv.slice(2);
const number = Number(issueRaw);
if (!['crash', 'resume'].includes(mode) || !stateDir || !Number.isSafeInteger(number) || number < 1) {
  throw new Error('Usage: node --import tsx github-close-recovery-probe.mjs crash|resume ISSUE STATE_DIR');
}
const options = { repository: process.env.FACTORY_GH_REPO, token: process.env.GH_TOKEN, stateDir };
const manager = createLeaseManager({ ...options, defaultBranch: 'main' });
const leaseFile = path.join(stateDir, 'close-probe-lease.json');
try {
  if (mode === 'crash') {
    const issue = await github.fetchIssue({ ...options, number });
    assert.equal(issue.title, 'Factory close recovery probe');
    assert.equal(issue.state, 'open');
    const lease = await manager.acquire(number, `${os.hostname()}:${process.pid}`);
    assert.ok(lease);
    await writeDurableJson(leaseFile, lease);
    const store = new GitHubStateStore({ ...options, leaseSha: lease.sha });
    const state = await store.read(number);
    assert.equal(state.revision ?? 0, 0);
    state.status = 'waiting';
    await runExternalOp(state, current => store.save(current), {
      kind: 'issue-close', idempotencyKey: 'dedicated-close-probe', payload: { number },
    }, async () => {
      await github.closeIssue({ ...options, number });
      console.log(`CLOSE_COMMITTED: issue=${number}; exit before ledger settlement`);
      process.exit(75);
    });
    throw new Error('Crash injection did not execute');
  }
  const lease = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  assert.equal(lease.issueNumber, number);
  const store = new GitHubStateStore({ ...options, leaseSha: lease.sha });
  try {
    await store.assertLease(number);
    await store.recover(number);
    const state = await store.load(number);
    assert.ok(state);
    await recoverExternalOps(state, options, current => store.save(current));
    const fresh = await store.load(number);
    assert.equal((await github.fetchIssue({ ...options, number })).state, 'closed');
    assert.equal(fresh.externalOps.filter(op => op.kind === 'issue-close').length, 1);
    assert.equal(fresh.externalOps.find(op => op.kind === 'issue-close').status, 'succeeded');
    assert.notEqual(fresh.status, 'completed', 'Closing alone must not bypass acceptance and review');
    assert.equal(await github.getRef({ ...options, ref: `heads/factory/leases/issue-${number}` }), lease.sha);
    console.log(`CLOSE_RECOVERY_PASS: issue=${number}; one intent; remote closed; no false task completion`);
  } finally {
    await manager.release(lease);
    console.log('CLOSE_PROBE_LEASE_RELEASED');
  }
} finally { await github.closeSharedAgent(); }
