// Opt-in read-only diagnosis over trusted checkpoints and actual execution artifacts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../../runtime/github-rest.mjs';
import * as verification from '../../src/agents/verify-behavior.ts';
import { hasAcceptanceCoverage } from '../../runtime/completion-contract.mjs';

const [repository, numberText, stateDir, mode = 'diagnose', envFile, sourceRunId] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && Number.isSafeInteger(number) && number > 0);
assert.ok(['diagnose', 'replay', 'compare-judgment'].includes(mode));
const replay = mode !== 'diagnose';
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const store = new GitHubStateStore({ repository, token, stateDir });
  const state = sourceRunId
    ? (await store.history(number)).toReversed().find(record =>
      record.envelope.snapshot.implementation?.behaviorVerification?.coverage?.runId === sourceRunId)?.envelope.snapshot
    : await store.load(number);
  assert.ok(state, 'A current or explicitly selected trusted historical execution is required');
  const before = structuredClone(state);
  const result = state?.implementation?.behaviorVerification;
  assert.ok(result?.receiptPath && result.coverage?.runId);
  const artifact = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(artifact.issue, number);
  assert.equal(artifact.runId, result.coverage.runId);
  const operator = artifact.receipts.filter(receipt => receipt.kind === 'operator-test');
  assert.equal(operator.length, 1);
  assert.equal(operator[0].passed, true);
  assert.equal(operator[0].detail.exitCode, 0);
  assert.ok(result.checks.length && result.checks.every(check => check.passed));
  assert.equal(result.checks.some(check => check.receiptIds.includes(operator[0].id)), false);
  const source = await readFile(new URL('../../src/agents/verify-behavior.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("minItems: this.mode === 'verify' ? 1 : 0"));
  const checks = replay
    ? [...result.checks, verification.operatorRegressionCheck(operator[0])]
    : result.checks;
  const operatorSupported = operator[0].passed && checks.some(check => check.receiptIds.includes(operator[0].id));
  const businessChecksUnchanged = JSON.stringify(checks.filter(check => check.requirementIds?.length))
    === JSON.stringify(result.checks.filter(check => check.requirementIds?.length));
  console.log(JSON.stringify({ issue: number, revision: state.revision, runId: artifact.runId,
    source: sourceRunId ? 'trusted-history' : 'current-state',
    businessChecks: result.checks.length, actualOperatorExitCode: operator[0].detail.exitCode,
    operatorSupported, businessChecksUnchanged, remoteWrites: 0, workerStarts: 0,
    productAcceptance: 'not-claimed' }));
  assert.equal(businessChecksUnchanged, true);
  assert.equal(operatorSupported, replay);
  if (replay) {
    assert.deepEqual(checks.at(-1).requirementIds, [], 'Command execution does not prove any AC');
    assert.deepEqual(checks.at(-1).receiptIds, [operator[0].id]);
    assert.equal(verification.receiptCheckSupported(checks.at(-1), artifact.receipts), true);
    assert.equal(hasAcceptanceCoverage(state.specs, state.implementation.commitSha, { ...result, checks }), true,
      'Actual business coverage remains valid with a separate factory engineering check');
  }
  if (mode === 'compare-judgment') {
    assert.ok(envFile, 'A credential file is required for opt-in live judgment');
    process.loadEnvFile(envFile);
    assert.ok(process.env.TYPESAFE_API_KEY);
    const current = sourceRunId ? await store.load(number) : state;
    const ctx = { issue: current.issue, runId: artifact.runId };
    for (const [variant, proposed] of [['original', result.checks], ['separate-engineering-check', checks]]) {
      const packet = verification.buildVerificationJudgmentState(ctx, 'verify', { result, checks: proposed }, artifact.receipts,
        { spec: state.specs, implementationSha: state.implementation.commitSha });
      const request = verification.buildTypesafeRequest(packet, process.env.FACTORY_TYPESAFE_MODEL || 'jev-latest');
      const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200, 'Live provider judgment must succeed; no fallback approval');
      const answer = await response.json();
      console.log(JSON.stringify({ variant, model: answer.model, checks: proposed.length,
        uncitedOperatorReceipts: packet.gaps.uncitedOperatorReceiptIds.length,
        judgment: answer.answers?.B9?.choice, confidence: answer.answers?.B9?.confidence,
        unsupportedCheckCount: proposed.filter((_, index) =>
          !(answer.answers?.[`B11-${index}`]?.noul >= 0.5)).length,
        inputTokens: answer.usage?.input_tokens, outputTokens: answer.usage?.output_tokens,
        remoteWrites: 0, workerStarts: 0, productAcceptance: 'not-claimed' }));
    }
  }
  assert.deepEqual(state, before);
} finally {
  closeSharedAgent();
}
