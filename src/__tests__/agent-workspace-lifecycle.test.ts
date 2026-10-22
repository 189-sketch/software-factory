import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { dispatchAgentStage, __clearAgentRuntimeCacheForTest } from '../core/agent-runtime.js';
import { SessionStore } from '../core/session-store.js';
import { SkillLoader } from '../core/skill.js';
import type { AgentContext, FactoryIssueState } from '../core/types.js';

const exec = promisify(execFile);

test('a worktree shares background and local skills while each agent continues its own durable conversation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-agent-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'issue-72');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(workdir);
  await exec('git', ['init', '-q', workdir]);
  await fs.writeFile(path.join(workdir, 'README.md'), 'Product repository\n');
  await exec('git', ['add', 'README.md'], { cwd: workdir });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: workdir });
  const script = path.join(root, 'claude.mjs');
  await fs.writeFile(script, `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => prompt += x);
process.stdin.on('end', () => {
 const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
 const id = args.includes('--resume') ? value('--resume') : args.includes('--session-id') ? value('--session-id') : randomUUID();
 const file = path.join(process.cwd(), '../calls.json');
 const calls = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
 const record = path.join(process.cwd(), '../state/sessions/72.json');
 const reserved = existsSync(record) && Object.values(JSON.parse(readFileSync(record, 'utf8')).providerSessions).some(x => x.providerSessionId === id);
 const modeFile = path.join(process.cwd(), '../failure-mode');
 const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8') : '';
 if (mode === 'missing' && args.includes('--resume')) { unlinkSync(modeFile); console.error('No conversation found with session ID: ' + id); process.exit(1); }
 if (mode === 'network') { console.error('Network request failed'); process.exit(1); }
 calls.push({ id, resume: args.includes('--resume'), reserved, prompt, tools: args.includes('--tools') ? value('--tools') : undefined });
 writeFileSync(file, JSON.stringify(calls));
 console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: id, result: mode === 'malformed' ? 'unusable response' : '{"ok":true}' }));
});
`);
  await fs.chmod(script, 0o755);
  let executable = script;
  if (process.platform === 'win32') {
    executable = path.join(root, 'claude.cmd');
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const values = { FACTORY_AGENT_BACKEND: 'claude-code', FACTORY_CLAUDE_COMMAND: executable };
  const before = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  __clearAgentRuntimeCacheForTest();
  t.after(() => {
    Object.keys(values).forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
    __clearAgentRuntimeCacheForTest();
  });
  const issue = { number: 72, title: 'feedback', body: 'Save feedback using SQLite', labels: [], comments: [], author: 'tester', url: '', createdAt: '' };
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  for (const [i, role] of ['spec', 'review-spec', 'spec', 'verify-behavior', 'verify-behavior'].entries()) {
    const state = { issue, merged: false, providerSessions: await new SessionStore(stateDir).load(72),
      implementation: { commitSha: `implementation-${i}` }, specs: { commitSha: `spec-${i}` } } as unknown as FactoryIssueState;
    const orchestrator: any = Object.create(FactoryOrchestrator.prototype);
    orchestrator.config = { paths: { stateDir }, limits: {} };
    orchestrator.repo = { owner: 'local', name: 'probe', workdir, defaultBranch: 'main' };
    orchestrator.loader = new SkillLoader(path.resolve('skills'), workdir);
    orchestrator.logger = logger;
    const ctx: AgentContext = await orchestrator.context(issue, role, `run-${i}`);
    await orchestrator.withProviderSession(state, role, ctx, async () => {
      for (const callRole of role === 'spec' ? ['spec-product', 'spec-tech'] : [role]) {
        await dispatchAgentStage(callRole, ctx, { systemPrompt: 'Complete the current stage using observed facts.',
          messages: [{ role: 'user', content: `Current stage: ${callRole}` }],
          tools: [{ name: 'observe', description: 'Observe the checkout', execute: async () => ({ observed: true }) }],
          outputContract: { requirements: [], example: { ok: true } }, parse: JSON.parse });
      }
      const shared = path.join(workdir, 'factory', 'AGENTS.md');
      const content = await fs.readFile(shared, 'utf8');
      if (i === 0) await fs.writeFile(shared, content + '\nSpec handoff: preserve the SQLite persistence decision.\n');
    });
  }
  const calls = JSON.parse(await fs.readFile(path.join(root, 'calls.json'), 'utf8'));
  assert.equal(calls.length, 7);
  assert.equal(new Set(calls.map((call: any) => call.id)).size, 3, 'Three agent identities require three sessions');
  assert.equal(calls[0].id, calls[1].id, 'Spec product and tech are turns of the spec agent');
  assert.equal(calls[0].id, calls[3].id, 'Spec repair must retain its conversation');
  assert.equal(calls[5].id, calls[6].id, 'New verification runId and commit must retain the verifier session');
  assert.notEqual(calls[0].id, calls[2].id, 'The reviewer must have independent memory');
  assert.ok(calls.every((call: any) => call.reserved), 'Persist session ownership before starting the CLI');
  const transcripts = new Map<string,string>();
  for (const [index, call] of calls.entries()) {
    const transcript = (transcripts.get(call.id) ?? '') + call.prompt;
    transcripts.set(call.id, transcript);
    if (index >= 2) assert.ok(transcript.includes('Spec handoff: preserve the SQLite persistence decision.')
      || (transcript.includes('Shared project files changed') && transcript.includes('factory/AGENTS.md')),
      'Each conversation receives the handoff text or an explicit instruction to read its changed source');
    assert.ok(transcript.includes('Save feedback using SQLite') && transcript.includes('## Required rule:'), 'Resumed turns retain previously delivered background and rules');
  }
  assert.ok(calls.every((call: any) => call.tools === 'Agent'));
  assert.match(await fs.readFile(path.join(workdir, 'AGENTS.md'), 'utf8'), /factory\/AGENTS.md/);
  assert.match(await fs.readFile(path.join(workdir, 'CLAUDE.md'), 'utf8'), /AGENTS.md/);
  assert.ok((await fs.stat(path.join(workdir, 'skills', 'verify-behavior', 'SKILL.md'))).isFile());
  const persisted = await new SessionStore(stateDir).load(72);
  assert.deepEqual(Object.keys(persisted).sort(), ['review-spec', 'spec', 'verify-behavior']);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: workdir })).stdout, '', 'Context updates must not dirty the approved code');
  await exec('git', ['clean', '-fd'], { cwd: workdir });
  assert.match(await fs.readFile(path.join(workdir, 'factory', 'AGENTS.md'), 'utf8'), /Spec handoff/);
  await fs.writeFile(path.join(workdir, 'feature.txt'), 'Product change');
  await exec('git', ['add', '-A', '--', ':!factory/'], { cwd: workdir });
  assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: workdir })).stdout.trim(), 'feature.txt', 'Product staging must exclude local context and skills');
  assert.deepEqual(await new SessionStore(stateDir).load(73), {}, 'Different issues cannot inherit these bindings');
  const state = { issue, merged: false, providerSessions: persisted } as FactoryIssueState;
  const orchestrator: any = Object.create(FactoryOrchestrator.prototype);
  Object.assign(orchestrator, { config: { paths: { stateDir }, limits: {} },
    repo: { owner: 'local', name: 'probe', workdir, defaultBranch: 'main' },
    loader: new SkillLoader(path.resolve('skills'), workdir), logger });
  const invoke = async (role: string) => {
    const ctx: AgentContext = await orchestrator.context(issue, role, 'recovery-run');
    return orchestrator.withProviderSession(state, role, ctx, () => dispatchAgentStage(role, ctx, {
      systemPrompt: 'Continue the task.', messages: [{ role: 'user', content: 'Recover the same conversation.' }],
      outputContract: { requirements: [], example: { ok: true } }, parse: JSON.parse,
    }));
  };
  await fs.writeFile(path.join(root, 'failure-mode'), 'malformed');
  await assert.rejects(invoke('triage'));
  const reserved = (await new SessionStore(stateDir).load(72)).triage.providerSessionId;
  assert.ok(reserved, 'A new conversation remains durable even when parsing and repair fail');
  await fs.writeFile(path.join(root, 'failure-mode'), 'network');
  await assert.rejects(invoke('triage'));
  assert.equal((await new SessionStore(stateDir).load(72)).triage.providerSessionId, reserved);
  await fs.writeFile(path.join(root, 'failure-mode'), 'missing');
  await invoke('triage');
  const recovered = JSON.parse(await fs.readFile(path.join(root, 'calls.json'), 'utf8')).at(-1);
  assert.equal(recovered.id, reserved, 'An explicitly missing reserved transcript is recreated with the same ID');
  assert.equal(recovered.resume, false);
  assert.equal((await new SessionStore(stateDir).load(72)).triage.providerSessionId, reserved);
});
