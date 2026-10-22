import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReviewSpecAgent } from '../agents/review-spec.js';
import { ReviewPrAgent } from '../agents/review-pr.js';
import { __clearAgentRuntimeCacheForTest } from '../core/agent-runtime.js';
import type { AgentContext, SpecPair } from '../core/types.js';

for (const kind of ['spec', 'pr']) {
test(`Review ${kind} gives its CLI and child agent access to immutable review inputs and worktree sources`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-review-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'worktree');
  const reviewDir = path.join(root, 'outside-worktree');
  await fs.mkdir(workdir);
  await fs.mkdir(reviewDir);
  await fs.writeFile(path.join(workdir, 'README.md'), 'Existing product source');
  const inputs: Record<string, string> = kind === 'spec' ? { 'spec_description.txt': 'Feedback spec', 'spec_diff.txt': '[NEW:1] Feedback',
    'spec_product.md': '## Acceptance criteria\n- AC-1 Persist feedback\n',
    'spec_tech.md': '## Validation plan\n- VP-1 Test persistence\n' }
    : { 'pr_description.txt': 'Feedback implementation', 'pr_diff.txt': 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n[OLD:1] Old source\n[NEW:1] Existing product source\n' };
  for (const [name, body] of Object.entries(inputs)) await fs.writeFile(path.join(reviewDir, name), body);
  const script = path.join(root, 'claude.mjs');
  const reviewResult = kind === 'pr' ? {
    verdict: 'REJECT', body: 'Found: 0 critical, 1 important, 0 suggestions, 0 nits.\n\n- [IMPORTANT] AC-2 VP-1 README.md:1 acknowledges success before durable commit, so failed storage loses data.', comments: [],
    references: [{ path: 'README.md', line: 1, side: 'RIGHT' }],
  } : { verdict: 'APPROVE', body: 'Found: 0 critical, 0 important, 0 suggestions, 0 nits.', notes: 'Read current inputs and sources.', comments: [], findings: [] };
  await fs.writeFile(script, `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => prompt += x);
process.stdin.on('end', async () => {
 const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
 const config = JSON.parse(readFileSync(value('--mcp-config'), 'utf8')).mcpServers.factory;
 const agents = JSON.parse(readFileSync(value('--agents'), 'utf8'));
 const client = new Client({ name: 'review-cli', version: '1' });
 try {
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  const names = (await client.listTools()).tools.map(x => x.name);
  if (!names.includes('read_file') || !names.includes('read_review_input')) throw new Error('Reviewer cannot read: ' + names);
  const observed = {};
  for (const name of ${JSON.stringify(Object.keys(inputs))}) {
   const result = await client.callTool({ name: 'read_review_input', arguments: { name } });
   if (result.isError) throw new Error(JSON.stringify(result));
   observed[name] = JSON.parse(result.content[0].text);
  }
  const source = await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } });
  const finalReview = ${JSON.stringify(reviewResult)};
  const attemptFile = ${JSON.stringify(path.join(root, 'attempt.txt'))};
  const attempt = existsSync(attemptFile) ? Number(readFileSync(attemptFile, 'utf8')) + 1 : 1;
  writeFileSync(attemptFile, String(attempt));
  let draftDiagnostics, validDiagnostics;
  if (${JSON.stringify(kind)} === 'pr' && attempt > 1) {
    if (!names.includes('validate_review')) throw new Error('Repair lost the coordinate validator');
    const invalid = await client.callTool({ name: 'validate_review', arguments: { reviewJson: JSON.stringify({ ...finalReview,
      comments: undefined, references: [{ path: 'README.md', line: 999, side: 'RIGHT' }] }) } });
    if (invalid.isError) throw new Error('Partial drafts must return actionable diagnostics');
    draftDiagnostics = JSON.parse(invalid.content[0].text);
    const valid = await client.callTool({ name: 'validate_review', arguments: { reviewJson: JSON.stringify(finalReview) } });
    if (valid.isError) throw new Error(JSON.stringify(valid));
    validDiagnostics = JSON.parse(valid.content[0].text);
    if (!validDiagnostics.valid) throw new Error(JSON.stringify(validDiagnostics));
  }
  writeFileSync(${JSON.stringify(path.join(root, 'observed.json'))}, JSON.stringify({ names, agents, observed, source, prompt, attempt, draftDiagnostics, validDiagnostics }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: value('--session-id'),
   result: JSON.stringify(${JSON.stringify(kind)} === 'pr' && attempt === 1
     ? { ...finalReview, references: [{ path: 'README.md', line: 999, side: 'RIGHT' }] } : finalReview) }));
 } catch (error) { console.error(error.message); process.exitCode = 1; }
 finally { await client.close(); }
});
`);
  await fs.chmod(script, 0o755);
  let executable = script;
  if (process.platform === 'win32') {
    executable = path.join(root, 'claude.cmd');
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const env = { FACTORY_AGENT_BACKEND: 'claude-code', FACTORY_CLAUDE_COMMAND: executable,
    FACTORY_REVIEW_DIR: reviewDir, FACTORY_TYPESAFE_OFF: '1' };
  const before = Object.keys(env).map(key => process.env[key]);
  Object.assign(process.env, env);
  __clearAgentRuntimeCacheForTest();
  t.after(() => {
    Object.keys(env).forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
    __clearAgentRuntimeCacheForTest();
  });
  const ctx = { repo: { owner: 'local', name: 'probe', defaultBranch: 'main', workdir },
    issue: { number: 77, title: 'feedback', body: 'Persist feedback', labels: [], comments: [], author: 'tester', url: '', createdAt: '' },
    skills: [], skillsRoot: path.resolve('skills'), runId: 'review-tools-e2e',
    projectContextFiles: [], logger: { info() {}, warn() {}, error() {} } } as unknown as AgentContext;
  const specs = { commitSha: 'approved-spec', product: { slug: 'feedback', acceptanceCriteria: ['Render form', 'Persist before success'] },
    tech: { validationPlan: ['Reject failed storage'] } } as SpecPair;
  const result = await (kind === 'spec' ? new ReviewSpecAgent(ctx) : new ReviewPrAgent(ctx, { specs })).run();
  assert.equal(result.verdict, kind === 'spec' ? 'APPROVE' : 'REJECT');
  if (kind === 'pr') {
    assert.deepEqual(result.findings?.[0].requirementIds, ['AC-2', 'VP-1']);
    assert.equal(result.findings?.[0].sourceRunId, ctx.runId);
    assert.match(result.findings?.[0].evidence.excerpt ?? '', /README\.md:1/);
    assert.equal(result.findings?.[0].evidence.path, 'README.md');
    assert.equal(result.findings?.[0].evidence.line, 1);
  }
  const observed = JSON.parse(await fs.readFile(path.join(root, 'observed.json'), 'utf8'));
  if (kind === 'pr') {
    assert.equal(observed.attempt, 2, 'Controller must await final coordinate validation and repair an invalid final report');
    assert.equal(observed.draftDiagnostics.valid, false);
    assert.ok(observed.draftDiagnostics.contractErrors.some((message: string) => message.includes('comments array')));
    assert.equal(observed.draftDiagnostics.missingLines[0].line, 999);
    assert.equal(observed.validDiagnostics.valid, true);
    assert.ok(observed.names.includes('validate_review'), 'Response repair keeps the read-only validation capability');
  }
  for (const [name, body] of Object.entries(inputs)) {
    assert.equal(observed.observed[name].content, body);
    assert.match(observed.observed[name].inputRevision, /^[a-f0-9]{64}$/);
    if ('inputRevision' in result) assert.equal(observed.observed[name].inputRevision, result.inputRevision);
  }
  assert.match(JSON.stringify(observed.source), /Existing product source/);
  assert.ok(observed.agents['factory-task'].tools.includes('mcp__factory__read_review_input'));
  assert.ok(observed.agents['factory-task'].tools.includes('mcp__factory__read_file'));
  assert.ok(!observed.names.includes('write_file'));
  assert.ok(!observed.names.includes('run_shell'));
});
}
