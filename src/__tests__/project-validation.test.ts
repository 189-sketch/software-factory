import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverProjectValidation } from '../core/project-validation.js';
import { defaultTools } from '../core/tools.js';
import type { AgentContext } from '../core/types.js';

test('validation discovery uses tracked Git evidence and explicitly reports adapter limits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-project-validation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  for (const [name, manifest] of [
    ['web app', { engines: { npm: '>=10' }, scripts: { typecheck: 'tsc --noEmit', deploy: 'never-run' } }],
    ['another', { packageManager: 'pnpm@9', scripts: { test: 'never-use-npm' } }],
  ] as const) {
    await fs.mkdir(path.join(dir, name));
    await fs.writeFile(path.join(dir, name, 'package.json'), JSON.stringify(manifest));
  }
  await fs.mkdir(path.join(dir, 'broken'));
  await fs.writeFile(path.join(dir, 'broken', 'package.json'), '{ broken');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'project evidence');
  await fs.writeFile(path.join(dir, 'web app', 'package.json'), '{}');
  const plan = await discoverProjectValidation(dir);
  assert.deepEqual(plan.checks.filter(check => check.program === 'npm'), [{ program: 'npm', args: ['run', 'typecheck'], cwd: 'web app', source: 'web app/package.json:scripts.typecheck' }]);
  assert.match(plan.baselineSha, /^[a-f0-9]{40}$/);
  assert.match(plan.notes.join('\n'), /another\/package.json: npm ownership not established/);
  const previous = process.env.FACTORY_TRUSTED_EXECUTION;
  t.after(() => {
    if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
    else process.env.FACTORY_TRUSTED_EXECUTION = previous;
  });
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  const ctx = { repo: { workdir: dir } } as AgentContext;
  const tool = defaultTools(ctx).find(tool => tool.name === 'run_process')!;
  const syntaxCheck = plan.checks.find(check => check.source === 'broken/package.json:manifest')!;
  const { source, ...request } = syntaxCheck;
  assert.notEqual((await tool.execute(request, ctx) as { exitCode: number }).exitCode, 0);
  await fs.writeFile(path.join(dir, 'broken', 'package.json'), '{}');
  assert.equal((await tool.execute(request, ctx) as { exitCode: number }).exitCode, 0);
});
