import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RecoveryScheduler, recoveryHash, recoveryNotice, publishRecoveryNotice } from '../runtime/recovery-scheduler.mjs';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../runtime/github-rest.mjs';
import { workerFailure, isWorkerFailure } from '../runtime/worker-failure.mjs';
import { businessInputHash } from '../runtime/business-input.mjs';
import { runtimeRecoveryInputHash } from '../runtime/recovery-context.mjs';
import { daemonRecoveryProbe } from './fixtures/daemon-recovery-probe.mjs';

test('persistent output contract failures park after three runs and a new build reopens admission', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-contract-recovery-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, repository: 'local/test', baseDelayMs: 1, maxDelayMs: 4 };
  const scheduler = new RecoveryScheduler(options);
  const context = recoveryHash('original-build');
  const failure = workerFailure(Object.assign(new Error('invalid'), {code: 'FACTORY_AGENT_OUTPUT_CONTRACT_INVALID'}));
  for (let attempt = 0; attempt < 3; attempt++) await scheduler.failed(86, context, failure, 1000 + attempt * 10);
  const restarted = new RecoveryScheduler(options);
  const admission = await restarted.admission(86, context, 9999999);
  assert.equal(admission.allowed, false, 'Expiry alone cannot rerun the same deterministic failure indefinitely');
  assert.match(recoveryNotice(admission.record, 4).body, /已暂停自动重试/);
  assert.doesNotMatch(recoveryNotice(admission.record, 4).body, /预计下次自动检查|暂不需要回复/);
  assert.equal((await restarted.admission(86, recoveryHash('fixed-build'), 9999999)).allowed, true);
  assert.equal((await restarted.admission(87, context, 9999999)).allowed, true);
});

test('changed runtime failures update the authored notice and a lost PATCH response cannot duplicate it', async () => {
  const comments=[{id:9,user:{login:'someone-else'},body:'<!-- pi-software-factory:operator-wait:runtime:foreign -->'}];
  const writes=[];
  let losePatch=false;
  setGitHubFetchImplForTest(async (url,options)=>{
    if(options.method==='GET')return new Response(JSON.stringify(comments));
    const body=JSON.parse(options.body).body;
    writes.push(options.method);
    if(options.method==='POST'){
      const comment={id:10,user:{login:'factory'},body};comments.push(comment);
      return new Response(JSON.stringify(comment));
    }
    assert.equal(options.method,'PATCH');
    assert.match(url,/\/issues\/comments\/10$/);
    comments[1].body=body;
    if(losePatch){losePatch=false;throw Object.assign(new Error('response lost'),{code:'ECONNRESET'});}
    return new Response(JSON.stringify(comments[1]));
  });
  try{
    const record={issueNumber:80,context:recoveryHash('first-build'),failure:workerFailure(new Error('first failure')),
      nextRetryAt:new Date(1_000_000).toISOString()};
    const options={token:'test',repository:'local/test',record,author:'factory',maxDelayMs:1_800_000};
    await publishRecoveryNotice(options);
    record.context=recoveryHash('next-build');record.nextRetryAt=new Date(2_000_000).toISOString();
    losePatch=true;
    await assert.rejects(publishRecoveryNotice(options));
    await publishRecoveryNotice(options);
    assert.deepEqual(writes,['POST','PATCH']);
    assert.equal(comments.length,2,'Only one factory status comment exists');
    assert.match(comments[0].body,/foreign/,'Another author is never edited');
    assert.equal(comments[1].body,recoveryNotice(record,1_800_000).body);
  }finally{setGitHubFetchImplForTest();closeSharedAgent();}
});

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

test('typed failure fingerprints ignore request timestamps and volatile CLI diagnostics', () => {
  const error=text=>Object.assign(new Error(text),{code:'FACTORY_AGENT_EXECUTION_FAILED'});
  assert.equal(workerFailure(error('exit=1 at 10:00, run=a')).fingerprint,
    workerFailure(error('exit=1 at 10:02, run=b')).fingerprint);
  assert.notEqual(workerFailure(error('CLI failed')).fingerprint,
    workerFailure(Object.assign(new Error('Prompt is too long'),{code:'FACTORY_AGENT_CONTEXT_EXHAUSTED'})).fingerprint);
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
    assert.equal(changedFailure.attempts, 13,'A different error without product progress cannot reset backoff');
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

test('recovery identity ignores fault saves, self-published labels and session bookkeeping', () => {
  const issue={number:77,state:'open',title:'Feedback',body:'Use SQLite',labels:['enhancement','verifying'],comments:[]};
  const state={revision:10,status:'waiting',nextLabel:'verifying',implementation:{commitSha:'reviewed'},reviewedSha:'reviewed'};
  const context=runtimeRecoveryInputHash(issue,state,'runtime-a');
  for(let n=0;n<5;n++) {
    assert.equal(runtimeRecoveryInputHash({...issue,labels:['enhancement','ready-to-merge'],comments:[{body:'<!-- pi-software-factory:operator-wait:runtime:notice -->'}]},
      {...state,revision:11+n,status:'failed',nextLabel:'ready-to-merge',agentRuntimeFailure:{at:new Date().toISOString()},
        providerSessions:{verifier:{attempt:n}},events:[{runId:`failure-${n}`} ]},'runtime-a'),context);
  }
  for(const [changedIssue,changedState,runtime] of [
    [{...issue,body:'Use a different schema'},state,'runtime-a'],
    [issue,{...state,implementation:{commitSha:'new-code'}},'runtime-a'],
    [issue,{...state,externalOps:[{id:'remote-pr',status:'succeeded',receipt:{operatorConfirmation:'Verified remote PR'}}]},'runtime-a'],
    [issue,state,'runtime-b'],
  ]) assert.notEqual(runtimeRecoveryInputHash(changedIssue,changedState,runtime),context);
  assert.equal(runtimeRecoveryInputHash(issue,{...state,externalOps:[{id:'label-sync-attempt',status:'failed',attempts:2}]},'runtime-a'),context);
});

test('operator notice is ignored as business input and explicitly explains recovery', () => {
  const record = { context: recoveryHash('input'), failure: workerFailure(new Error('runtime failure')),
    nextRetryAt: new Date(1_000_000).toISOString() };
  const notice = recoveryNotice(record, 1_800_000);
  const issue = { number: 7, title: 'Issue', comments: [] };
  assert.equal(businessInputHash(issue), businessInputHash({ ...issue, comments: [{ body: notice.body }] }));
  assert.match(notice.body, /暂不需要回复/);
  assert.match(notice.body, /工厂正在自动恢复/);
  assert.doesNotMatch(notice.body, /需要你的操作|业务重试预算|磁盘|首次预计恢复检查时间/);
  assert.match(notice.body, /故障诊断（供维护者排查）/);
  assert.match(notice.body, /不代表 issue 已完成/);
});

test('connection timeout diagnostics retain the actual transport cause and reserve action requests for confirmed permission failures', () => {
  const failure = workerFailure(Object.assign(new Error('save failed', { cause: Object.assign(new Error('connect failed'), {
    githubRequest: { resource: 'git-ref', method: 'GET', phase: 'connect', attempt: 4,
      elapsedMs: 10008, timeoutMs: 10000, transportCode: 'UND_ERR_CONNECT_TIMEOUT' },
  }) }), { code: 'FACTORY_STATE_UNAVAILABLE', stateOperation: 'save' }));
  assert.ok(isWorkerFailure(failure));
  assert.equal(failure.request.transportCode, 'UND_ERR_CONNECT_TIMEOUT');
  const record = { context: recoveryHash('input'), failure, nextRetryAt: new Date(1_000_000).toISOString() };
  const notice = recoveryNotice(record, 1_800_000);
  assert.match(notice.body, /保存运行进度/);
  assert.match(notice.body, /UND_ERR_CONNECT_TIMEOUT/);
  assert.doesNotMatch(notice.body, /需要维护者处理|权限|磁盘/);
  const denied = recoveryNotice({ ...record, failure: { ...failure, request: { ...failure.request, status: 403 } } }, 1_800_000);
  assert.match(denied.body, /需要维护者处理：GitHub 返回 HTTP 403/);
  assert.ok(!isWorkerFailure({ ...failure, request: { ...failure.request, transportCode: 'private-address' } }));
});
