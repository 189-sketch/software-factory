import test from 'node:test';
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

test('implementation validation exposes stdout failures before any publish operation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-validation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  await fs.mkdir(cwd);
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd });
  await git('init');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  const output = JSON.stringify({
    filesChanged: ['example.txt'], comment: 'Validated implementation fixture',
    validationCommands: ['node -e "console.log(\'expected failed assertion\');process.exit(7)"'],
  });
  const script = path.join(dir, 'claude.mjs');
  await fs.writeFile(script, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'succeeded', output, usage: null, warnings: [] }))}));\n`);
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
    issue: { number: 1, title: 'Validation', body: '', labels: [], comments: [], author: 'test', url: '', createdAt: '' },
    repo: { owner: 'local', name: 'test', defaultBranch: 'main', workdir: cwd },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [], skillsRoot: dir, runId: 'validation-test',
  } satisfies AgentContext;
  let writes = 0;
  const store = { save: async () => { writes++; throw new Error('Must not publish failed validation'); } } as unknown as IssueStateStore;
  await assert.rejects(new ImplementationAgent(ctx, 'unused', {} as FactoryIssueState, store).run(), error => {
    assert.match(String(error), /Implementation validation failed/);
    assert.match(String(error), /exit 7/);
    assert.match(String(error), /stdout:\s+expected failed assertion/);
    return true;
  });
  assert.equal(writes, 0);
});
