import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RecoveryScheduler, recoveryHash, recoveryNotice } from '../runtime/recovery-scheduler.mjs';
import { workerFailure, isWorkerFailure } from '../runtime/worker-failure.mjs';
import { businessInputHash } from '../runtime/business-input.mjs';
import { daemonRecoveryProbe } from './fixtures/daemon-recovery-probe.mjs';

test('real daemon isolates repeated failures across restart without starving another issue', { timeout: 45000 }, async () => {
  await daemonRecoveryProbe();
});

test('uncaught CLI failure is flushed as a structured non-success envelope', () => {
  const cli = fileURLToPath(new URL('../dist/factory/run-issue.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--unknown-argument'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.ok(isWorkerFailure(summary.runtimeFailure));
  assert.equal(summary.runtimeFailure.owner, 'worker-runtime');
  assert.equal(summary.status, undefined);
  assert.equal(summary.merged, undefined);
});

test('failure identity preserves cause without publishing messages, stacks, or credentials', () => {
  const cause = new DOMException('aborted sk-ant-secret', 'AbortError');
  const error = Object.assign(new Error('save failed', { cause }), { code: 'FACTORY_STATE_UNAVAILABLE' });
  const failure = workerFailure(error);
  assert.equal(failure.owner, 'state-runtime');
  assert.equal(failure.code, 'FACTORY_STATE_UNAVAILABLE');
  assert.equal(workerFailure(error).fingerprint, failure.fingerprint);
  assert.ok(!JSON.stringify(failure).includes('sk-ant-secret'));
  assert.notEqual(workerFailure(new Error('another fault')).fingerprint, failure.fingerprint);
  assert.equal(cause.code, 20);
  assert.ok(!isWorkerFailure({ ...failure, fingerprint: 'invalid' }));
  error.cause = error;
  assert.ok(isWorkerFailure(workerFailure(error)), 'cyclic causes are bounded');
});

test('safe request diagnostics explain recovery without changing failure identity or leaking private fields', () => {
  const request = { resource: 'issue-comments', method: 'GET', phase: 'body', attempt: 1,
    elapsedMs: 10001, timeoutMs: 10000, status: 200, page: 2, perPage: 100 };
  const cause = Object.assign(new Error('Request failed'), { githubRequest: request });
  const error = Object.assign(new Error('State read failed', { cause }),
    { code: 'FACTORY_STATE_UNAVAILABLE', stateOperation: 'read' });
  const failure = workerFailure(error);
  assert.equal(failure.operation, 'read');
  assert.deepEqual(failure.request, request);
  assert.ok(isWorkerFailure(failure));
  const notice = recoveryNotice({ context: recoveryHash('input'), failure,
    nextRetryAt: new Date(1000000).toISOString() }, 1800000);
  assert.match(notice.body, /故障环节：read/);
  assert.match(notice.body, /issue-comments \/ body/);
  assert.match(notice.body, /第 2 页，每页 100 条/);
  request.elapsedMs = 10020; request.attempt = 4; request.page = 3;
  assert.equal(workerFailure(error).fingerprint, failure.fingerprint, 'Timings and pagination cannot reset recovery backoff');
  assert.equal(failure.request.elapsedMs, 10001, 'Published diagnostics do not alias the mutable source');
  cause.githubRequest = { ...request, token: 'private-token' };
  assert.equal(workerFailure(error).request, undefined);
  assert.ok(!JSON.stringify(workerFailure(error)).includes('private-token'));
  assert.ok(!isWorkerFailure({ ...failure, request: cause.githubRequest }));
  assert.ok(!isWorkerFailure({ ...failure, operation: 'private-token' }));
  assert.ok(isWorkerFailure({ version: failure.version, owner: failure.owner, code: failure.code, fingerprint: failure.fingerprint }),
    'Older persisted failures without diagnostics remain valid');
});

test('admission survives restart, backs off without progress, and resumes on changed context or expiry', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-recovery-'));
  const options = { stateDir, repository: 'owner/repo', baseDelayMs: 1000, maxDelayMs: 4000 };
  const context = recoveryHash({ input: 'original', revision: 12, runtime: 'build-a' });
  const failure = workerFailure(Object.assign(new Error('save failed'), { code: 'FACTORY_STATE_UNAVAILABLE' }));
  const scheduler = new RecoveryScheduler(options);
  const start = 1_000_000;
  try {
    assert.equal((await scheduler.admission(42, context, start)).allowed, true);
    const first = await scheduler.failed(42, context, failure, start);
    assert.equal(Date.parse(first.nextRetryAt), start + 1000);
    const restarted = new RecoveryScheduler(options);
    assert.equal((await restarted.admission(42, context, start + 999)).allowed, false);
    assert.equal((await restarted.admission(42, context, start + 1000)).allowed, true);
    const second = await restarted.failed(42, context, failure, start + 1000);
    assert.equal(second.attempts, 2);
    assert.equal(Date.parse(second.nextRetryAt), start + 3000);
    for (let index = 0; index < 10; index++) {
      const record = await scheduler.failed(42, context, failure, start + 3000 + index * 4000);
      assert.equal(Date.parse(record.nextRetryAt), start + 7000 + index * 4000);
    }
    for (const changed of [{ input: 'new', revision: 12, runtime: 'build-a' },
      { input: 'original', revision: 13, runtime: 'build-a' }, { input: 'original', revision: 12, runtime: 'build-b' }]) {
      assert.equal((await scheduler.admission(42, recoveryHash(changed), start)).allowed, true);
    }
    assert.equal((await scheduler.admission(43, context, start)).allowed, true, 'other issues are not quarantined');
    const otherRepo = new RecoveryScheduler({ ...options, repository: 'owner/other' });
    assert.equal((await otherRepo.admission(42, context, start)).allowed, true);
    const changedFailure = await scheduler.failed(42, context, workerFailure(new Error('new fault')), start);
    assert.equal(changedFailure.attempts, 1);
    const changedInput = await scheduler.failed(42, recoveryHash('new-context'), failure, start);
    assert.equal(changedInput.attempts, 1);
    await scheduler.clear(42);
    assert.equal((await restarted.admission(42, context, start)).allowed, true);
    await scheduler.write(42, { ...first, noticeAttemptedAt: 'invalid-date' });
    await assert.rejects(scheduler.admission(42, context, start), /Invalid recovery admission journal/);
    await assert.rejects(scheduler.failed(43, 'not-a-hash', failure, start), /admission context/);
    assert.ok(!await fs.stat(path.join(stateDir, 'issues')).catch(() => null), 'no workflow checkpoint was written');
  } finally {
    assert.equal(path.dirname(stateDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(stateDir).startsWith('factory-recovery-'));
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('operator notice is ignored as business input and explicitly explains recovery', () => {
  const record = { context: recoveryHash('input'), failure: workerFailure(new Error('runtime failure')),
    nextRetryAt: new Date(1_000_000).toISOString() };
  const notice = recoveryNotice(record, 1_800_000);
  const issue = { number: 7, title: 'Issue', comments: [] };
  assert.equal(businessInputHash(issue), businessInputHash({ ...issue, comments: [{ body: notice.body }] }));
  assert.match(notice.body, /暂不需要回复/);
  assert.match(notice.body, /需要你的操作/);
  assert.match(notice.body, /不代表 issue 已完成/);
});
