import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ImplementationAgent } from '../agents/implementation.js';
import { __clearAgentRuntimeCacheForTest } from '../core/agent-runtime.js';
import type { AgentContext, FactoryIssueState } from '../core/types.js';
import type { IssueStateStore } from '../core/state.js';

async function retryFixture(t: TestContext, dirty: boolean, advanced: boolean | 'diverged' = false, recovery?: 'runtime' | 'legacy-contract' | 'unexpected-stop' | 'foreign-session') {
  const preserve = Boolean(recovery && recovery !== 'foreign-session');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-implementation-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(cwd, 'README.md'), 'baseline');
  if (advanced === 'diverged') {
    await fs.mkdir(path.join(cwd,'specs','retry'),{recursive:true});
    await fs.writeFile(path.join(cwd,'specs','retry','PRODUCT.md'),'Previous product\n');
    await fs.writeFile(path.join(cwd,'specs','retry','TECH.md'),'Previous technology\n');
  }
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  await git('checkout', '-b', 'feature/issue-1-retry');
  if (dirty) {
    await fs.writeFile(path.join(cwd, 'README.md'), 'previous tracked implementation');
    await fs.writeFile(path.join(cwd, 'feature.txt'), 'previous uncommitted implementation');
  }
  let specs: FactoryIssueState['specs'];
  let priorHead: string | undefined;
  if (advanced === 'diverged') {
    await fs.writeFile(path.join(cwd, 'retained.txt'), 'previous committed implementation');
    await git('add', 'retained.txt');
    await git('commit', '-m', 'prior implementation');
    priorHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  }
  if (advanced) {
    await git('init', '--bare', path.join(root, 'origin.git'));
    await git('remote', 'add', 'origin', path.join(root, 'origin.git'));
    await git('checkout', 'main');
    await fs.mkdir(path.join(cwd, 'specs', 'retry'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'specs', 'retry', 'PRODUCT.md'), 'Approved product\n');
    await fs.writeFile(path.join(cwd, 'specs', 'retry', 'TECH.md'), 'Approved technology\n');
    await git('add', 'specs');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'approved specs');
    const commitSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('push', 'origin', 'main');
    await git('checkout', 'feature/issue-1-retry');
    specs = { commitSha, product: { slug: 'retry', body: 'Approved product\n' },
      tech: { slug: 'retry', body: 'Approved technology\n' } } as FactoryIssueState['specs'];
  }

  const output = JSON.stringify({ filesChanged: ['feature.txt'], comment: 'Reimplemented feature',
    validationCommands: [{ program: 'node', args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('feature.txt','utf8'),'reimplemented');console.log('recreated feature validated');process.exit(7)"] }] });
  const argsFile = path.join(root, 'args.json');
  const script = path.join(root, 'claude.mjs');
  await fs.writeFile(script, `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';const args=process.argv.slice(2);writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(args));process.stdin.resume();process.stdin.on('end',()=>{${preserve ? "if(readFileSync('README.md','utf8')!=='previous tracked implementation'||readFileSync('feature.txt','utf8')!=='previous uncommitted implementation')throw new Error('Recovery discarded completed work');" : ''}writeFileSync('feature.txt','reimplemented');process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'succeeded', output, usage: null, warnings: [] }))});});\n`);
  await fs.chmod(script, 0o755);
  let executable = script;
  if (process.platform === 'win32') {
    executable = path.join(root, 'claude.cmd');
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const keys = ['FACTORY_CLAUDE_COMMAND', 'FACTORY_AGENT_BACKEND', 'FACTORY_AGENT_OVERRIDES', 'FACTORY_TRUSTED_EXECUTION'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    __clearAgentRuntimeCacheForTest();
  });
  process.env.FACTORY_CLAUDE_COMMAND = executable;
  process.env.FACTORY_AGENT_BACKEND = 'claude-code';
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  delete process.env.FACTORY_AGENT_OVERRIDES;
  __clearAgentRuntimeCacheForTest();
  const ctx = {
    issue: { number: 1, title: 'Retry', body: '', labels: [], comments: [], author: 'test', url: '', createdAt: '' },
    repo: { owner: 'local', name: 'test', defaultBranch: 'main', workdir: cwd },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [], skillsRoot: root, runId: 'retry-test', resumeSessionId: '11111111-1111-4111-8111-111111111111',
  } satisfies AgentContext;
  const state = { specs, ...(priorHead ? { implementation: {commitSha:priorHead} } : {}), ...(recovery === 'runtime' ? { agentRuntimeFailure: { stage: 'implementation', code: 'FACTORY_AGENT_OUTPUT_CONTRACT_INVALID' } }
    : recovery === 'legacy-contract' ? { lastFailure: { stage: 'implementation', class: 'AGENT_REASONING', message: 'Implementation supplied no validation commands; refusing to publish' } }
    : recovery ? { providerSessions: { implementation: { providerSessionId: ctx.resumeSessionId, backend: 'claude-code',
      workdir: recovery === 'foreign-session' ? path.join(root, 'foreign-worktree') : cwd } } } : {}) } as FactoryIssueState;
  const store = { save: async (saved: FactoryIssueState) => {
    assert.ok(saved.validationFailure, 'Persist exact validation evidence for recovery');
    assert.equal(saved.externalOps?.length ?? 0, 0, 'Failed validation must not publish');
  } } as unknown as IssueStateStore;
  let failure: unknown;
  try { await new ImplementationAgent(ctx, 'unused', state, store).run(); } catch (error) { failure = error; }
  assert.doesNotMatch(String(failure), /Approved specification checkout mismatch/,
    'A revised approved spec must advance the existing implementation branch before invoking the agent');
  const args = JSON.parse(await fs.readFile(argsFile, 'utf8')) as string[];
  if (dirty || advanced) {
    assert.equal(args.includes('--resume'), true, 'changed checkout must retain the agent conversation');
    assert.equal(await fs.readFile(path.join(cwd, 'feature.txt'), 'utf8'), 'reimplemented');
    assert.equal(await fs.readFile(path.join(cwd, 'README.md'), 'utf8'), preserve ? 'previous tracked implementation' : 'baseline');
    assert.match(String(failure), /recreated feature validated/);
  } else {
    assert.equal(args.includes('--resume'), true, 'unchanged checkout can continue its existing session');
  }
  assert.match(String(failure), /Implementation validation failed/);
  if (advanced === 'diverged') {
    assert.equal(await fs.readFile(path.join(cwd,'retained.txt'),'utf8'),'previous committed implementation');
    assert.equal((await fs.readFile(path.join(cwd,'specs','retry','PRODUCT.md'),'utf8')).replace(/\r\n/g,'\n'),'Approved product\n');
    await git('merge-base','--is-ancestor',priorHead!,'HEAD');
  }
}

test('implementation retry continues its session after discarding uncommitted work', t => retryFixture(t, true));
test('implementation retry preserves its session when cleanup discards no work', t => retryFixture(t, false));
test('implementation retry continues its session after advancing to newly approved specs', t => retryFixture(t, false, true));
test('implementation retry incorporates revised approved specs without discarding an existing feature commit', t => retryFixture(t, false, 'diverged'));
test('agent output contract recovery preserves tracked and untracked work before continuing its session', t => retryFixture(t, true, false, 'runtime'));
test('legacy missing-command recovery preserves completed work before continuing its session', t => retryFixture(t, true, false, 'legacy-contract'));

test('unexpected process termination preserves unfinished work owned by the same issue agent session', t => retryFixture(t, true, false, 'unexpected-stop'));

test('a session from a different worktree cannot authorize retaining unrelated changes', t => retryFixture(t, true, false, 'foreign-session'));
