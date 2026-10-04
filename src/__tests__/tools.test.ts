import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeAgentCommand, defaultTools } from '../core/tools.js';
import type { AgentContext } from '../core/types.js';

test('agent tools refuse repository credential and internal state files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-tools-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=value');
  await fs.writeFile(path.join(dir, '.env.example'), 'SECRET=replace-me');
  const ctx = {
    repo: { owner: 'local', name: 'target', defaultBranch: 'main', workdir: dir },
    issue: { number: 1, title: 'Test', body: '', labels: [], author: 'test', url: '', createdAt: '', comments: [] },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [],
    skillsRoot: dir,
    runId: 'tools-test',
  } satisfies AgentContext;
  const read = defaultTools(ctx).find((tool) => tool.name === 'read_file')!;
  await assert.rejects(read.execute({ path: '.env' }, ctx), /credential file/);
  const example = await read.execute({ path: '.env.example' }, ctx) as { content: string };
  assert.match(example.content, /replace-me/);
  await assert.rejects(read.execute({ path: '.factory/issues/1.json' }, ctx), /Protected repository metadata/);
});

test('agent shell policy blocks credential files and publishing commands', () => {
  assert.throws(() => assertSafeAgentCommand('Get-Content .env'), /credential file/);
  assert.throws(() => assertSafeAgentCommand('git push origin main'), /VCS write operations/);
  assert.throws(() => assertSafeAgentCommand('npm publish'), /Publishing from agent is not allowed/);
  assert.doesNotThrow(() => assertSafeAgentCommand('npm test'));
  assert.throws(() => assertSafeAgentCommand('cd template && npm test'), /npm --prefix template test/);
  assert.doesNotThrow(() => assertSafeAgentCommand('npm --prefix template test'));
  assert.doesNotThrow(() => assertSafeAgentCommand('npm --prefix template run lint'));
});

test('quoted Node validation executes literal JavaScript without shell expansion', async (t) => {
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
    else process.env.FACTORY_TRUSTED_EXECUTION = previous;
  });
  const ctx = { repo: { workdir: process.cwd() } } as AgentContext;
  const tool = defaultTools(ctx).find((entry) => entry.name === 'run_shell')!;
  const code = "const assert=require('node:assert/strict');assert.ok(20 >= 10 && 10 < 20);assert.match('abc',/^[a-z]+$/);console.log('$HOME $(echo injected) `literal`');";
  const result = await tool.execute({ command: `node -e "${code}"` }, ctx) as { exitCode: number; stdout: string };
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '$HOME $(echo injected) `literal`');
  const escaped = await tool.execute({ command: 'node -e "console.log(\\"quoted\\");console.log(/\\d+/.test(\\"123\\"))"' }, ctx) as { exitCode: number; stdout: string };
  assert.equal(escaped.exitCode, 0);
  assert.match(escaped.stdout, /quoted\r?\ntrue/);
});

test('Node inline exception does not allow trailing shell operations or credential paths', () => {
  for (const command of [
    'node -e "console.log(1)" | bash',
    'node -e "console.log(1)" > output.txt',
    'node -e "console.log(1)"; npm publish',
    'node -e "console.log(1)" && npm test',
    'node -e "unterminated',
    'npm test; node app.js',
  ]) {
    assert.throws(() => assertSafeAgentCommand(command));
  }
  assert.throws(() => assertSafeAgentCommand('node -e "console.log(1)" .env'));
});

test('timed-out validation retains its process error when stderr is empty', async (t) => {
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
    else process.env.FACTORY_TRUSTED_EXECUTION = previous;
  });
  const ctx = { repo: { workdir: process.cwd() } } as AgentContext;
  const tool = defaultTools(ctx).find((entry) => entry.name === 'run_shell')!;
  const result = await tool.execute({ command: 'node -e "setTimeout(()=>{},5000)"', timeoutMs: 50 }, ctx) as { exitCode: number; stderr: string };
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Command failed/);
});

test('fetch_issue returns normalized comments and does not flag deficiency when comments exist', async () => {
  const ctx = {
    repo: { owner: 'local', name: 'target', defaultBranch: 'main', workdir: process.cwd() },
    issue: {
      number: 3,
      title: '脚手架',
      body: '创建一个基于react的前端脚手架项目',
      labels: ['needs-info'],
      author: '189-sketch',
      url: 'https://github.com/x/y/issues/3',
      createdAt: '2026-09-13T02:36:04Z',
      comments: [
        { author: '189-sketch', body: '使用TS，其它的你自己决定', createdAt: '2026-09-13T02:45:32Z' },
      ],
    },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [],
    skillsRoot: process.cwd(),
    runId: 'fetch-issue-test',
  } satisfies AgentContext;

  const fetchIssue = defaultTools(ctx).find((tool) => tool.name === 'fetch_issue')!;
  const rich = (await fetchIssue.execute({ issueNumber: 3 }, ctx)) as {
    issue: { comments: Array<{ author: string; body: string; createdAt: string }> };
    comments: Array<{ author: string; body: string; createdAt: string }>;
    commentsPresent: number;
    dataDeficient: boolean;
  };
  assert.equal(rich.commentsPresent, 1, 'one comment present');
  assert.equal(rich.dataDeficient, false, 'data is sufficient');
  assert.deepEqual(rich.comments.map((c) => c.body), ['使用TS，其它的你自己决定']);
  assert.equal(rich.issue.comments.length, 1);
});

test('fetch_issue flags dataDeficient when comments are missing on a non-empty body', async () => {
  const ctx = {
    repo: { owner: 'local', name: 'target', defaultBranch: 'main', workdir: process.cwd() },
    issue: {
      number: 4,
      title: 'Empty thread',
      body: 'A real body that exists.',
      labels: [],
      author: 'someone',
      url: '',
      createdAt: '',
      comments: [],
    },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [],
    skillsRoot: process.cwd(),
    runId: 'fetch-issue-deficient-test',
  } satisfies AgentContext;

  const fetchIssue = defaultTools(ctx).find((tool) => tool.name === 'fetch_issue')!;
  const result = (await fetchIssue.execute({ issueNumber: 4 }, ctx)) as {
    dataDeficient: boolean;
    commentsPresent: number;
  };
  assert.equal(result.dataDeficient, true, 'must flag data deficiency so triage knows to retry');
  assert.equal(result.commentsPresent, 0);
});

test('fetch_issue does not flag dataDeficient when issue body itself is empty', async () => {
  const ctx = {
    repo: { owner: 'local', name: 'target', defaultBranch: 'main', workdir: process.cwd() },
    issue: {
      number: 5,
      title: 'Truly empty',
      body: '',
      labels: [],
      author: 'someone',
      url: '',
      createdAt: '',
      comments: [],
    },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [],
    skillsRoot: process.cwd(),
    runId: 'fetch-issue-empty-test',
  } satisfies AgentContext;

  const fetchIssue = defaultTools(ctx).find((tool) => tool.name === 'fetch_issue')!;
  const result = (await fetchIssue.execute({ issueNumber: 5 }, ctx)) as {
    dataDeficient: boolean;
  };
  // When the body is empty too, the agent has nothing to reason over — but
  // `dataDeficient` only fires when the body is non-empty AND comments are
  // missing, so the triage agent can tell "missing comments on a real thread"
  // apart from "no data at all".
  assert.equal(result.dataDeficient, false);
});
