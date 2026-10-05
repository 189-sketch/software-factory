import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { VerifyBehaviorAgent, setVerifyBehaviorFetchImpl } from '../agents/verify-behavior.js';
import { AgentRuntimeImpl } from '../core/agent-runtime.js';
import type { AgentContext, SpecPair } from '../core/types.js';
import { VERIFICATION_CAPABILITY_HASH } from '../../runtime/verification-capabilities.mjs';

test('real stage retries use distinct immutable tool registries matching manifests and lifecycle logs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-run-identity-'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const env = { FACTORY_TYPESAFE_OFF: '0', TYPESAFE_API_KEY: 'fixture', FACTORY_TRUSTED_EXECUTION: '1', FACTORY_VERIFY_COMMAND: '' };
  const previous = Object.keys(env).map(key => process.env[key]);
  Object.assign(process.env, env);
  const messages: string[] = [];
  let executions = 0;
  const logger = { info(message: string) { messages.push(message); }, warn() {}, error() {}, child() { return this; } };
  const issue = { number: 7, title: 'CLI behavior', body: 'Assert expected output', author: 'fixture', labels: [], comments: [], createdAt: '', url: '' };
  const spec = { commitSha: 'spec', product: { body: 'Expected output', acceptanceCriteria: ['Expected output'] } } as SpecPair;
  const state: any = { issue, merged: false };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.repo = { owner: 'local', name: 'probe', defaultBranch: 'main', workdir: root };
  orchestrator.config = { syncProjects: false, limits: { commandTimeoutMs: 2000 }, paths: { stateDir: path.join(root, 'state') } };
  orchestrator.store = { save: async () => state };
  orchestrator.logger = logger;
  orchestrator.loader = { load: async (name: string) => ({ name, description: name }) };
  orchestrator.emit = () => {};
  try {
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      executions++;
      const receipt = await request.tools!.find(tool => tool.name === 'run_acceptance_test')!.execute(
        { program: 'node', args: ['-e', 'require("node:assert/strict").equal(1, 1)'] }, context) as any;
      await request.tools!.find(tool => tool.name === 'record_acceptance_check')!.execute(
        { criterion: 'Expected output', requirementIds: ['AC-1'], receiptIds: [receipt.id] }, context);
      return { status: 'succeeded', output: JSON.stringify({ status: 'verified', channel: 'desktop', notes: 'Observed output', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    setVerifyBehaviorFetchImpl((async () => new Response(JSON.stringify({ answers: {
      B9: { type: 'choice', choice: 'verified', probabilities: { verified: 1 }, confidence: 1 },
      'B11-0': { type: 'noul', noul: 0.9 },
    } }))) as typeof fetch);
    const runs: Array<{ ctx: AgentContext; file: string; bytes: string }> = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await orchestrator.stage(state, 'verify', async (runId: string) => {
        const ctx = await orchestrator.context(issue, 'verify-behavior', runId);
        assert.equal(ctx.runId, state.stages.verify.runId);
        const result = await new VerifyBehaviorAgent(ctx, 'verify', { spec, implementationSha: 'implementation' }).run();
        runs.push({ ctx, file: result.receiptPath!, bytes: await fs.readFile(result.receiptPath!, 'utf8') });
        return result;
      });
      assert.equal(result.coverage.runId, state.stages.verify.runId);
      const manifest = state.events.findLast((event: any) => event.verdict?.includes('manifest-'));
      assert.ok(manifest.verdict.includes(result.coverage.runId));
      assert.ok(messages.some(message => message.includes(`started runId=${result.coverage.runId}`)));
      assert.equal(JSON.parse(runs.at(-1)!.bytes).executionCapabilities, VERIFICATION_CAPABILITY_HASH);
    }
    assert.notEqual(runs[0]!.ctx.runId, runs[1]!.ctx.runId);
    assert.notEqual(runs[0]!.file, runs[1]!.file);
    assert.equal(await fs.readFile(runs[0]!.file, 'utf8'), runs[0]!.bytes);
    await assert.rejects(new VerifyBehaviorAgent(runs[0]!.ctx, 'verify', { spec, implementationSha: 'implementation' }).run(),
      { code: 'FACTORY_STATE_EVIDENCE_IDENTITY_REUSED' });
    assert.equal(executions, 2, 'Reused identity must be rejected before any execution');
    assert.equal(await fs.readFile(runs[0]!.file, 'utf8'), runs[0]!.bytes, 'An accidental reused identity must not overwrite original receipts');
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    setVerifyBehaviorFetchImpl(null);
    Object.keys(env).forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-run-identity-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
