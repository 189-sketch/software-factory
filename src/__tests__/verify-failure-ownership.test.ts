import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../core/agent-runtime.js';
import { VerifyBehaviorAgent, setVerifyBehaviorFetchImpl } from '../agents/verify-behavior.js';
import { hasProductVerificationFailure } from '../core/verification-recovery.js';
import type { AgentContext, FactoryIssueState, SpecPair } from '../core/types.js';

test('production verification issues failure ownership from real receipts and independent judgment, not agent prose', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-failure-owner-'));
  const workdir = path.join(root, 'project');
  await fs.mkdir(workdir);
  const original = AgentRuntimeImpl.prototype.runStage;
  const values = { FACTORY_TYPESAFE_OFF: '0', TYPESAFE_API_KEY: 'test', FACTORY_TRUSTED_EXECUTION: '1', FACTORY_VERIFY_COMMAND: '' };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  const spec = { commitSha: 'approved-spec', product: { body: 'CLI assertion proves AC-1', acceptanceCriteria: ['Expected output'] } } as SpecPair;
  try {
    for (const scenario of ['product', 'evidence', 'missing', 'timeout'] as const) {
      const ctx = { repo: { owner: 'local', name: 'probe', defaultBranch: 'main', workdir },
        issue: { number: 1, title: 'CLI behavior', body: 'Acceptance assertion', labels: [], comments: [], author: 'probe', createdAt: '', url: '' },
        logger: { info() {}, warn() {}, error() {}, child() { return this; } },
        skills: [], skillsRoot: workdir, runId: randomUUID(), artifactStateDir: path.join(root, 'state'),
        correction: { targetStage: 'verify-behavior', turns: ['Previous verification used the wrong assertion scope; do not modify product code.'] },
      } satisfies AgentContext;
      AgentRuntimeImpl.prototype.runStage = async (request, context) => {
        assert.ok(JSON.stringify(request.inputManifest).includes(ctx.correction.turns[0]!), 'Recovery feedback must reach the actual verifier prompt');
        const execute = request.tools!.find(tool => tool.name === 'run_acceptance_test')!;
        const register = request.tools!.find(tool => tool.name === 'record_acceptance_check')!;
        const invocation = scenario === 'timeout'
          ? { program: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], timeoutMs: 50 }
          : { program: 'node', args: ['-e', 'require("node:assert/strict").equal(1, 2)'] };
        const receipt = await execute.execute(invocation, context) as any;
        assert.equal(receipt.passed, false);
        await assert.rejects(register.execute({ criterion: 'Expected output', requirementIds: ['AC-1'], receiptIds: [receipt.id] }, context));
        await assert.rejects(register.execute({ criterion: 'Expected output', requirementIds: ['AC-1'], receiptIds: ['fake'], passed: false }, context));
        await register.execute({ criterion: 'Expected output', requirementIds: ['AC-1'], receiptIds: [receipt.id], passed: false }, context);
        return { status: 'succeeded', output: JSON.stringify({ status: 'not-verified', channel: 'desktop', notes: 'Observed negative assertion', checks: [],
          failure: { kind: 'product', receiptIds: ['fake'], requirementIds: ['invented'] } }),
          usage: null, backend: 'claude-code', warnings: [], retryable: false };
      };
      setVerifyBehaviorFetchImpl((async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        assert.equal(request.questions.B12.type, 'choice');
        assert.deepEqual(Object.keys(request.questions.B12.criteria), ['product', 'evidence', 'tool']);
        assert.deepEqual(request.state.verificationChecks[0].requirementIds, ['AC-1']);
        assert.equal(request.state.verificationChecks[0].passed, false);
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {
          B9: { type: 'choice', choice: 'not-verified', probabilities: { 'not-verified': 1 }, confidence: 1 },
          'B11-0': { type: 'noul', noul: 0.1 },
          ...(scenario === 'missing' ? {} : { B12: { type: 'choice', choice: scenario === 'evidence' ? 'evidence' : 'product',
            probabilities: { product: scenario === 'evidence' ? 0 : 1, evidence: scenario === 'evidence' ? 1 : 0, tool: 0 }, confidence: 1 } }),
        }, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200 });
      }) as typeof fetch);
      const result = await new VerifyBehaviorAgent(ctx, 'verify', { spec, implementationSha: 'implementation' }).run();
      assert.equal(result.failure?.kind, scenario === 'product' ? 'product' : scenario === 'timeout' ? 'tool' : 'evidence');
      assert.equal(result.failure?.runId, ctx.runId);
      assert.ok(!result.failure?.receiptIds.includes('fake'));
      const state = { specs: spec, implementation: { commitSha: 'implementation', behaviorVerification: result } } as FactoryIssueState;
      assert.equal(hasProductVerificationFailure(state), scenario === 'product');
      const registry = JSON.parse(await fs.readFile(result.receiptPath!, 'utf8'));
      assert.equal(registry.receipts.length, 1);
      assert.equal(registry.receipts[0].passed, false);
      assert.equal(registry.runId, ctx.runId);
    }
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    setVerifyBehaviorFetchImpl(null);
    Object.keys(values).forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-failure-owner-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
