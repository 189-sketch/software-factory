import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntimeImpl } from '../core/agent-runtime.js';
import { runAgentJudgment } from '../core/judgment-context.js';
import { resolveAgentConfig } from '../../runtime/agent-backends.mjs';
import type { AgentContext } from '../core/types.js';
import type { TypesafeRequest } from '../../runtime/typesafe-backend.d.mts';
import { parseLlmJudgment } from '../core/judgment-llm-fallback.js';

test('LLM answers cannot omit evidence questions, invent ids or bypass probability validation', () => {
  const request: TypesafeRequest = { model: 'jev-latest', state: {}, questions: {
    check: { type: 'noul', instructions: 'Is this demonstrated?' },
    overall: { type: 'choice', instructions: 'Verdict', criteria: { yes: 'All supported', no: 'Not supported' } },
    score: { type: 'score', instructions: 'Quality', criteria: ['Low', 'High'] },
  } };
  const valid = [{ id: 'check', value: false, confidence: 0.2 }, { id: 'overall', value: 'no', confidence: 0.9 }, { id: 'score', value: 0.3, confidence: 0.7 }];
  assert.deepEqual(parseLlmJudgment(JSON.stringify({ answers: [...valid].reverse() }), request), valid);
  for (const invalid of [valid.slice(1), [valid[0], valid[0], valid[2]],
    [{ ...valid[0], id: '__proto__' }, ...valid.slice(1)],
    [{ ...valid[0], value: true }, ...valid.slice(1)],
    [{ ...valid[0], confidence: '0.2' }, ...valid.slice(1)],
    [valid[0], { ...valid[1], value: 'APPROVE' }, valid[2]],
    [valid[0], valid[1], { ...valid[2], value: 2 }]]) {
    assert.throws(() => parseLlmJudgment(JSON.stringify({ answers: invalid }), request));
  }
});

for (const scenario of ['restricted', 'invalid', 'unavailable', 'healthy'] as const) {
  test(`judgment transport ${scenario} preserves evidence and only HTTP 451 invokes a separate LLM`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-llm-judgment-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
    const original = AgentRuntimeImpl.prototype.runStage;
    t.after(() => { AgentRuntimeImpl.prototype.runStage = original; });
    const ctx = { issue: { number: 90 }, repo: { owner: 'local', name: 'test', workdir: root }, runId: 'current',
      agentId: 'executor', resumeSessionId: 'executor-session', skills: [], skillsRoot: root,
      artifactStateDir: path.join(root, 'state'), logger: { info() {}, warn() {}, error() {} },
      persistProviderSession: async () => { throw new Error('Must not replace executor session'); } } as unknown as AgentContext;
    const request: TypesafeRequest = { model: 'jev-latest', state: { prDiff: 'PINNED_ACTUAL_CODE',
      specification: { product: { acceptanceCriteria: ['Distinct task ids across navigation'] } } },
      questions: { B7: { type: 'choice', instructions: 'Does the implementation satisfy the approved requirements?',
        criteria: { APPROVE: 'Supported', REJECT: 'Observed violation' } },
        B8: { type: 'noul', instructions: 'Does the cited code prove a defect?' } } };
    let calls = 0;
    AgentRuntimeImpl.prototype.runStage = async (input, context) => {
      calls++;
      assert.equal(input.resumeSessionId, undefined);
      assert.notEqual(context.agentId, ctx.agentId);
      assert.deepEqual(input.tools, []);
      assert.ok(input.inputManifest.messages[0]!.content.includes('PINNED_ACTUAL_CODE'));
      assert.ok(input.inputManifest.messages[0]!.content.includes('Distinct task ids across navigation'));
      const output = JSON.stringify({ answers: [{ id: 'B7', value: scenario === 'invalid' ? 'INVENTED' : 'REJECT', confidence: 0.93 },
        { id: 'B8', value: true, confidence: 0.91 }] });
      return { status: 'succeeded', output, usage: null, backend: 'claude-code', warnings: [], retryable: false, providerSessionId: 'judge-session' };
    };
    const env = { ...process.env, TYPESAFE_API_KEY: 'test', FACTORY_TYPESAFE_OFF: '0' };
    const result = await runAgentJudgment('review-pr', ctx, resolveAgentConfig(env), 'typesafe', request, { env,
      fetchImpl: async () => scenario === 'healthy'
        ? new Response(JSON.stringify({ answers: { B7: { type: 'choice', choice: 'REJECT', confidence: 0.9 }, B8: { type: 'noul', noul: 0.9 } } }))
        : new Response('', { status: scenario === 'unavailable' ? 500 : 451 }) });
    assert.equal(ctx.resumeSessionId, 'executor-session');
    assert.equal(calls > 0, scenario === 'restricted' || scenario === 'invalid');
    assert.equal(result.status, scenario === 'restricted' || scenario === 'healthy' ? 'succeeded' : 'failed');
    if (scenario === 'restricted') {
      assert.equal(result.backend, 'claude-code');
      assert.deepEqual(result.structuredOutput, [{ id: 'B7', value: 'REJECT', confidence: 0.93 }, { id: 'B8', value: true, confidence: 0.91 }]);
      assert.ok(result.warnings.some(warning => warning.includes('HTTP 451')));
    }
    if (scenario === 'invalid') assert.equal(result.structuredOutput, undefined);
  });
}
