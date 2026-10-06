import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VerificationServices } from '../core/verification-services.js';
import { receiptCheckSupported } from '../agents/verify-behavior.js';
import type { AgentContext } from '../core/types.js';

const source = "require('node:http').createServer((request,response)=>response.end(JSON.stringify({secretPresent:Boolean(process.env.FACTORY_API_KEY),cwd:process.cwd(),args:process.argv.slice(2)}))).listen(Number(process.argv[1]),'127.0.0.1');";
const context = { repo: { owner: 'local', name: 'service-test', defaultBranch: 'main', workdir: process.cwd() },
  issue: { number: 1, title: 'Service', body: '', labels: [], comments: [], author: 'test', url: '', createdAt: '' },
  // Use the production startup budget, including the first cold Windows job-helper compilation.
  skills: [], skillsRoot: process.cwd(), runId: 'service-test', commandTimeoutMs: 30_000,
  logger: { info() {}, warn() {}, error() {}, child() { return this; } } } satisfies AgentContext;
const invocation = { program: 'node', args: ['-e', source, '{port}'], url: 'http://127.0.0.1:0' };
const accessible = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } };

test('owned services stay live after readiness, strip credentials and issue non-AC lifecycle receipts', async t => {
  const previous = { trusted: process.env.FACTORY_TRUSTED_EXECUTION, key: process.env.FACTORY_API_KEY };
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  process.env.FACTORY_API_KEY = 'private-service-key';
  t.after(() => {
    if (previous.trusted === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
    else process.env.FACTORY_TRUSTED_EXECUTION = previous.trusted;
    if (previous.key === undefined) delete process.env.FACTORY_API_KEY;
    else process.env.FACTORY_API_KEY = previous.key;
  });
  const receipts: any[] = [];
  const manager = new VerificationServices(context, receipt => receipts.push(receipt));
  t.after(() => manager.close());
  const [start, stop] = manager.tools();
  const extra = ['space argument', '', 'ends\\', 'quote"value'];
  const result = await start.execute({ ...invocation, args: [...invocation.args, ...extra] }, context) as any;
  assert.equal(result.passed, true, JSON.stringify(result.detail));
  assert.ok(Number(new URL(result.url).port) > 0);
  const body = await (await fetch(result.url)).json();
  assert.equal(body.secretPresent, false);
  assert.equal(body.cwd.toLowerCase(), process.cwd().toLowerCase());
  assert.deepEqual(body.args, extra, 'The Windows job wrapper must preserve exact argv boundaries');
  assert.equal(receiptCheckSupported({ criterion: 'Startup is not acceptance', passed: true, receiptIds: [result.id] }, receipts), false);
  await assert.rejects(stop.execute({ serviceId: String(result.detail.pid) }, context), /Unknown serviceId/);
  const stopped = await stop.execute({ serviceId: result.serviceId }, context) as any;
  assert.equal(stopped.stopped, true);
  assert.equal(await accessible(result.url), false);
  assert.deepEqual(receipts.map(receipt => [receipt.detail.action, receipt.passed]), [['start', true], ['stop', true]]);
});

test('service requests cannot bypass confinement, execution policy or listener ownership', async t => {
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => { if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION; else process.env.FACTORY_TRUSTED_EXECUTION = previous; });
  const receipts: any[] = [];
  const manager = new VerificationServices(context, receipt => receipts.push(receipt));
  t.after(() => manager.close());
  const start = manager.tools()[0];
  for (const mutation of [
    { url: 'https://127.0.0.1:0' }, { url: 'http://example.com' }, { url: 'http://user:password@127.0.0.1' },
    { url: 'http://127.0.0.1/?token=private' }, { timeoutMs: NaN }, { env: { API_KEY: 'private' } },
    { program: 'git', args: ['push'] }, { cwd: '..' }, { program: 'bash', args: ['-c', 'echo bypass'] },
    { args: ['-e', "require('node:fs').readFileSync('.env')", '{port}'] },
  ]) await assert.rejects(start.execute({ ...invocation, ...mutation }, context));
  const server = createServer((_, response) => response.end('unrelated'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  await assert.rejects(start.execute({ ...invocation, url }, context), /occupied/);
  assert.equal(await accessible(url), true, 'Never stop or reuse the unrelated service');
  assert.equal(receipts.length, 0);
  delete process.env.FACTORY_TRUSTED_EXECUTION;
  await assert.rejects(start.execute(invocation, context), /TRUSTED_EXECUTION/);
});

test('startup failures preserve redacted diagnostics, stop the process tree and cannot prove an AC', async t => {
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => { if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION; else process.env.FACTORY_TRUSTED_EXECUTION = previous; });
  for (const code of ["console.error('API_KEY=private-file-value');process.exit(23);", 'setInterval(()=>{},1000);']) {
    const receipts: any[] = [];
    const manager = new VerificationServices(context, receipt => receipts.push(receipt));
    t.after(() => manager.close());
    const result = await manager.tools()[0].execute({ ...invocation, args: ['-e', code, '{port}'], timeoutMs: code.includes('process.exit') ? 10_000 : 1000 }, context) as any;
    assert.equal(result.passed, false);
    assert.equal(await accessible(result.url), false);
    assert.ok(['SERVICE_READY_TIMEOUT', 'SERVICE_EXITED_BEFORE_READY'].includes(result.error));
    assert.ok(!JSON.stringify(receipts).includes('private-file-value'));
    if (code.includes('process.exit')) assert.match(result.detail.logTail, /\[REDACTED\]/);
    assert.equal(receiptCheckSupported({ criterion: 'Startup alone is not an AC', passed: true, receiptIds: [result.id] }, receipts), false);
    assert.deepEqual(receipts.map(receipt => [receipt.detail.action, receipt.passed]), [['start', false], ['stop', true]]);
  }
});

test('service readiness cannot extend the operator execution ceiling', async t => {
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => { if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION; else process.env.FACTORY_TRUSTED_EXECUTION = previous; });
  const receipts: any[] = [];
  const limited = { ...context, commandTimeoutMs: 250 };
  const manager = new VerificationServices(limited, receipt => receipts.push(receipt));
  t.after(() => manager.close());
  const result = await manager.tools()[0].execute({ ...invocation,
    args: ['-e', 'setInterval(()=>{},1000);', '{port}'], timeoutMs: 10_000 }, limited) as any;
  assert.equal(result.passed, false);
  assert.equal(result.error, 'SERVICE_READY_TIMEOUT');
  assert.equal(await accessible(result.url), false);
  assert.deepEqual(receipts.map(receipt => [receipt.detail.action, receipt.passed]), [['start', false], ['stop', true]]);
});

test('service cleanup owns descendants even after an intermediate launcher exits', async t => {
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => { if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION; else process.env.FACTORY_TRUSTED_EXECUTION = previous; });
  const middle = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(source)},process.argv[1]],{detached:process.platform==='win32',stdio:['ignore','ignore','inherit']});child.unref();process.exit(0);`;
  const launcher = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)},process.argv[1]],{stdio:['ignore','ignore','inherit']});setInterval(()=>{},1000);`;
  const manager = new VerificationServices(context, () => {});
  t.after(() => manager.close());
  const result = await manager.tools()[0].execute({ ...invocation, args: ['-e', launcher, '{port}'] }, context) as any;
  assert.equal(result.passed, true, JSON.stringify(result.detail));
  assert.equal(await accessible(result.url), true);
  await manager.close();
  assert.equal(await accessible(result.url), false, 'PID ancestry alone cannot prove cleanup after the middle process exits');
});

test('abrupt worker death closes its control pipe and removes owned application descendants', { timeout: 20_000 }, async t => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../test/fixtures/service-owner-probe.mjs', import.meta.url))], {
    cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let result: any, buffer = '', stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (result?.url && await accessible(result.url) && result.supervisorPid) {
      // Only the supervisor PID issued by this owned fixture, cleanup after a failing assertion.
      if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(result.supervisorPid), '/T', '/F'], { windowsHide: true });
      else process.kill(-result.supervisorPid, 'SIGKILL');
    }
  });
  result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker fixture did not become ready')), 12_000);
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); }
    });
    child.once('exit', code => { clearTimeout(timer); if (!result) reject(new Error(`Worker exited before readiness: ${code}; ${stderr}`)); });
  });
  assert.equal(result.passed, true);
  assert.equal(await accessible(result.url), true);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const deadline = Date.now() + 8000;
  while (await accessible(result.url) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await accessible(result.url), false, 'Guardian must clean up without an owner finally block');
});
