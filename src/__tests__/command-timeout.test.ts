import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { commandTimeoutPolicy, commandRecoveryStage, commandTimeoutRecoveryStage, commandTimeoutRetryPending } from '../../runtime/command-timeout.mjs';
import { defaultTools } from '../core/tools.js';
import type { AgentContext } from '../core/types.js';

test('test, build, dependency install and ordinary commands have separate invocation limits', () => {
  for (const [command, profile, timeoutMs] of [
    ['git status --short', 'command', 120000], ['npm --prefix template run test', 'test', 1200000],
    ['node test/run-tests.js', 'test', 1200000], ['node --test', 'test', 1200000],
    ['python -m pytest', 'test', 1200000], ['npm run build', 'build', 600000],
    ['npm ci', 'install', 600000], ['npm run lint', 'check', 300000],
  ] as const) assert.deepEqual(commandTimeoutPolicy({ command }), { profile, timeoutMs });
  assert.equal(commandTimeoutPolicy({ program: 'node', args: ['custom-gate.js'] }, { validationCommand: true }).timeoutMs, 1200000);
  assert.equal(commandTimeoutPolicy({ command: 'npm run build', timeoutMs: 900000 }).timeoutMs, 900000);
  assert.equal(commandTimeoutPolicy({ command: 'npm test', timeoutMs: 99999999 }, { validationTimeoutMs: 5000 }).timeoutMs, 5000);
});

test('trusted command timeout checkpoints resume after backoff and legacy needs-info can recover', () => {
  const checkpoint = { status: 'waiting', nextLabel: 'ready-to-implement',
    lastFailure: { stage: 'implementation', class: 'COMMAND_TIMEOUT', message: 'node test/run-tests.js timed out' },
    wait: { reason: 'runtime-retry', nextAttemptAt: new Date(2000).toISOString() } };
  assert.equal(commandTimeoutRecoveryStage(checkpoint), 'implementation');
  assert.equal(commandTimeoutRetryPending(checkpoint, 1000), true);
  assert.equal(commandTimeoutRetryPending(checkpoint, 2000), false);
  const legacy = { status: 'failed', nextLabel: 'needs-info',
    error: '[failure-classifier] ENVIRONMENT: configured command execution budget exhausted',
    lastFailure: { stage: 'implementation', class: 'ENVIRONMENT', message: 'node test/run-tests.js; command timed out after 120000ms' } };
  assert.equal(commandTimeoutRecoveryStage(legacy), 'implementation');
  assert.equal(commandTimeoutRecoveryStage({ ...legacy, error: 'Missing GitHub write permission' }), null);
  assert.equal(commandTimeoutRecoveryStage({ ...checkpoint, wait: { reason: 'blocked-operator' } }), null);
  assert.equal(commandTimeoutRecoveryStage({ ...checkpoint, status: 'completed' }), null);
});

test('legacy dependency installation failures resume without admitting unrelated needs-info checkpoints', () => {
  const legacy = { status: 'failed', nextLabel: 'needs-info',
    error: '[failure-classifier] ENVIRONMENT: environment / git / fs error',
    lastFailure: { stage: 'implementation', class: 'ENVIRONMENT', message: 'Implementation validation failed: npm ci (exit 1)\nstderr:\nEPERM unlink esbuild.exe' } };
  assert.equal(commandRecoveryStage(legacy), 'implementation');
  assert.equal(commandRecoveryStage({ ...legacy, error: 'Author must clarify requirements' }), null);
  assert.equal(commandRecoveryStage({ ...legacy, wait: { reason: 'blocked-operator' } }), null);
  assert.equal(commandRecoveryStage({ ...legacy, issue: { state: 'closed' } }), null);
  assert.equal(commandRecoveryStage({ ...legacy, lastFailure: { ...legacy.lastFailure, message: 'Missing permission' } }), null);
  const current = { ...legacy, error: undefined, lastFailure: { ...legacy.lastFailure, class: 'VALIDATION_FAILED' },
    wait: { reason: 'runtime-retry', nextAttemptAt: new Date(2000).toISOString() } };
  assert.equal(commandRecoveryStage(current), 'implementation');
  assert.equal(commandTimeoutRetryPending(current, 1000), true);
  assert.equal(commandTimeoutRetryPending(current, 2000), false);
});

test('real command execution lets a slow test exceed the ordinary limit and kills timed-out descendants', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-command-timeout-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const trusted = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => { if (trusted === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION; else process.env.FACTORY_TRUSTED_EXECUTION = trusted; });
  await fs.mkdir(path.join(root, 'test'));
  await fs.writeFile(path.join(root, 'test', 'run-tests.cjs'), "setTimeout(()=>console.log('slow test passed'),250)");
  const events: { message: string; details: any }[] = [];
  const ctx = { repo: { workdir: root }, commandTimeoutMs: 50, validationTimeoutMs: 2000,
    logger: { info: (message: string, details: any) => events.push({ message, details }) } } as unknown as AgentContext;
  const tool = defaultTools(ctx).find(item => item.name === 'run_process')!;
  const slow = await tool.execute({ program: 'node', args: ['test/run-tests.cjs'] }, ctx) as any;
  assert.equal(slow.exitCode, 0, slow.stderr);
  assert.match(slow.stdout, /slow test passed/);
  assert.equal(slow.timeoutMs, 2000);
  const heartbeat = path.join(root, 'child-heartbeat.txt');
  const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20)`)}],{stdio:'inherit'});console.log('child started');setInterval(()=>{},1000)`;
  const timed = await tool.execute({ program: 'node', args: ['-e', script], timeoutMs: 1000 }, { ...ctx, commandTimeoutMs: 1000 }) as any;
  assert.equal(timed.timedOut, true);
  const outcomes = events.filter(event => event.message === '[command] finished').map(event => event.details);
  assert.equal(outcomes[0].profile, 'test');
  assert.equal(outcomes[0].exitCode, 0);
  assert.equal(outcomes[1].timedOut, true);
  assert.equal(outcomes[1].exitCode, timed.exitCode);
  assert.ok(outcomes.every(event => !('args' in event) && !('stdout' in event) && !('stderr' in event)));
  const failed = await tool.execute({ program: 'node', args: ['-e', "console.error('private output');process.exit(7)"], timeoutMs: 1000 }, ctx) as any;
  assert.equal(failed.exitCode, 7);
  assert.equal(events.at(-1)!.details.exitCode, 7);
  assert.doesNotMatch(JSON.stringify(events), /private output|child-heartbeat/);
  assert.match(timed.stdout, /child started/);
  const before = await fs.readFile(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await fs.readFile(heartbeat, 'utf8'), before, 'Recovery must not overlap a surviving child process');
});
