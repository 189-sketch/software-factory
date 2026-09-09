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
    skillBody: '',
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
});
