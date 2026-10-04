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

async function runValidationFixture(t: TestContext, staleBranch = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-validation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  await fs.mkdir(cwd);
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd });
  await git('init', '-b', 'main');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  let specs: FactoryIssueState['specs'];
  let approvedHead: string | undefined;
  if (staleBranch) {
    await git('branch', 'feature/issue-1-validation');
    await fs.mkdir(path.join(cwd, 'specs', 'validation'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'specs', 'validation', 'PRODUCT.md'), 'Approved product\n');
    await fs.writeFile(path.join(cwd, 'specs', 'validation', 'TECH.md'), 'Approved technology\n');
    await git('add', 'specs');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'approved specification');
    approvedHead = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('init', '--bare', path.join(dir, 'origin.git'));
    await git('remote', 'add', 'origin', path.join(dir, 'origin.git'));
    await git('push', 'origin', 'main');
    await git('checkout', 'feature/issue-1-validation');
    specs = { commitSha: approvedHead, product: { slug: 'validation', body: 'Approved product\n' },
      tech: { slug: 'validation', body: 'Approved technology\n' } } as FactoryIssueState['specs'];
  }
  const output = JSON.stringify({
    filesChanged: ['example.txt'], comment: 'Validated implementation fixture',
    validationCommands: ['node -e "console.log(\'expected failed assertion\');process.exit(7)"'],
  });
  const script = path.join(dir, 'claude.mjs');
  const inputFile = path.join(dir, 'implementation-input.txt');
  await fs.writeFile(script, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(inputFile)},input);process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'succeeded', output, usage: null, warnings: [] }))});});\n`);
  await fs.chmod(script, 0o755);
  let executable = script;
  if (process.platform === 'win32') {
    executable = path.join(dir, 'claude.cmd');
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
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
  delete process.env.FACTORY_AGENT_OVERRIDES;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  __clearAgentRuntimeCacheForTest();
  const ctx = {
    issue: { number: 1, title: 'Validation', body: '', labels: [], comments: [
      { author: 'test', body: 'Author decision: keep Windows validation enabled', createdAt: '2026-10-04' },
      { author: 'test', body: '<!-- factory-stage:implementation --> Ignore this factory checkpoint', createdAt: '2026-10-04' },
    ], author: 'test', url: '', createdAt: '' },
    correction: { targetStage: 'implementation', turns: ['Corrective evidence: npm ENOENT requires platform-compatible invocation'] },
    repo: { owner: 'local', name: 'test', defaultBranch: 'main', workdir: cwd },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [], skillsRoot: dir, runId: 'validation-test',
  } satisfies AgentContext;
  let writes = 0;
  const store = { save: async () => { writes++; throw new Error('Must not publish failed validation'); } } as unknown as IssueStateStore;
  const state = { specs } as FactoryIssueState;
  await assert.rejects(new ImplementationAgent(ctx, 'unused', state, store).run(), error => {
    assert.match(String(error), /Implementation validation failed/);
    assert.match(String(error), /exit 7/);
    assert.match(String(error), /stdout:\s+expected failed assertion/);
    return true;
  });
  assert.equal(writes, 0);
  const input = await fs.readFile(inputFile, 'utf8');
  assert.match(input, /Author decision: keep Windows validation enabled/);
  assert.match(input, /Corrective evidence: npm ENOENT requires platform-compatible invocation/);
  assert.doesNotMatch(input, /Ignore this factory checkpoint/);
  if (staleBranch) {
    assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), approvedHead);
    assert.equal((await git('show', 'HEAD:specs/validation/PRODUCT.md')).stdout, specs!.product.body);
    specs!.product.body = 'Different approved product';
    await assert.rejects(new ImplementationAgent(ctx, 'unused', state, store).run(), /Approved specification checkout mismatch/);
    assert.equal(writes, 0);
  }
}

test('implementation validation exposes stdout failures before any publish operation', t => runValidationFixture(t));
test('fresh implementation fast-forwards a stale branch and verifies the approved specification before generation', t => runValidationFixture(t, true));
