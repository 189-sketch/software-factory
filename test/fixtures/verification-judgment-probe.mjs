// Audit a real trusted verification without executing or writing the workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { hasImplementationApproval, hasAcceptanceCoverage } from '../../runtime/completion-contract.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [repository, numberText, stateDir, envFile, workdir, mode] = process.argv.slice(2);
assert.ok(mode === undefined || ['diagnose-batch', 'diagnose-global', 'diagnose-missing-checks', 'diagnose-actions-only'].includes(mode));
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0 && stateDir);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
assert.ok(state?.implementation?.behaviorVerification, 'Requires actual trusted verification');
const verification = state.implementation.behaviorVerification;
const approval = hasImplementationApproval(state);
console.log(JSON.stringify({ revision: state.revision, status: verification.status,
  independentJudgmentPresent: Boolean(verification.judgment), implementationApproval: approval,
  remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
if (!verification.judgment) assert.equal(approval, false, 'Unjudged real verification must not authorize completion');
if (envFile) {
  assert.ok(workdir, 'Actual judgment requires the dedicated checkout');
  process.loadEnvFile(envFile);
  const { VerifyBehaviorAgent, setVerifyBehaviorFetchImpl } = await import('../../src/agents/verify-behavior.ts');
  const runId = verification.coverage?.runId;
  assert.match(runId ?? '', /^[a-f0-9-]{36}$/);
  const namespace = createHash('sha256').update(repository).digest('hex');
  const receiptPath = path.join(stateDir, 'evidence', namespace, String(number), runId, 'acceptance.json');
  const originalBytes = await readFile(receiptPath);
  const registry = JSON.parse(originalBytes.toString('utf8'));
  assert.equal(registry.issue, number);
  assert.equal(registry.runId, runId);
  const [owner, name] = repository.split('/');
  const logger = { warn(message) { console.error(message); }, info() {}, error() {}, child() { return this; } };
  const context = { issue: state.issue, repo: { owner, name, defaultBranch: 'main', workdir }, runId, logger, artifactStateDir: stateDir };
  setVerifyBehaviorFetchImpl(async (url, options) => {
    const request = JSON.parse(options.body);
    if (mode === 'diagnose-global') request.questions = { B9: request.questions.B9 };
    const body = JSON.stringify(request);
    const sizes = Object.values(request.questions).map(question => Buffer.byteLength(JSON.stringify(question)));
    console.log(JSON.stringify({ revision: state.revision, requestBytes: Buffer.byteLength(body),
      stateBytes: Buffer.byteLength(JSON.stringify(request.state)), questionBytes: sizes.reduce((sum, bytes) => sum + bytes, 0),
      largestQuestionBytes: Math.max(0, ...sizes), questions: sizes.length, receipts: registry.receipts.length,
      stateSections: Object.fromEntries(Object.entries(request.state).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])),
      passedChecks: verification.checks.filter(check => check.passed).length,
      requiredAcceptanceCriteria: request.state.requirements?.length,
      projectedReceipts: request.state.factory?.lastReceiptRegistry?.receipts?.length,
      omittedSuccessfulActions: request.state.gaps?.omittedSuccessfulActionCount,
      uncoveredRequirements: request.state.gaps?.uncoveredRequirementIds?.length,
      brokenBrowserChains: request.state.gaps?.brokenBrowserChains?.length,
      truncatedReceipts: request.state.gaps?.truncatedReceiptIds?.length,
      unknownProjectedReceiptIds: request.state.gaps?.unknownReceiptIds?.length,
      sourceChecksWithUnknownReceipts: verification.checks.filter(check => check.receiptIds.some(id => !registry.receipts.some(receipt => receipt.id === id))).length,
      sourceCompleteExecutionCoverage: hasAcceptanceCoverage(state.specs, state.implementation.commitSha, verification),
      sourceOperatorReceiptsCited: registry.receipts.filter(receipt => receipt.kind === 'operator-test')
        .every(receipt => verification.checks.some(check => check.receiptIds.includes(receipt.id))),
      remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
    let response;
    try {
      response = await fetch(url, { ...options, body,
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) });
    } catch (error) {
      const code = error.cause?.code ?? error.name;
      console.log(JSON.stringify({ networkFailure: /^[A-Za-z_0-9]{1,80}$/.test(code ?? '') ? code : 'NETWORK_FAILURE' }));
      throw error;
    }
    if (!response.ok) {
      const error = await response.clone().json().catch(() => null);
      console.log(JSON.stringify({ upstreamStatus: response.status, upstreamErrorFields: Object.keys(error?.detail ?? error ?? {}),
        numericLimits: Object.fromEntries(Object.entries(error?.detail ?? {}).filter(([key, value]) =>
          /^[a-z_]{1,80}$/.test(key) && typeof value === 'number')) }));
    } else {
      const payload = await response.clone().json();
      console.log(JSON.stringify({ upstreamUsage: Object.fromEntries(Object.entries(payload.usage ?? {}).filter(([key, value]) =>
        ['input_tokens', 'output_tokens'].includes(key) && Number.isSafeInteger(value) && value >= 0)) }));
    }
    return response;
  });
  try {
    const agent = new VerifyBehaviorAgent(context, 'verify', { spec: state.specs, implementationSha: state.implementation.commitSha });
    if (mode?.startsWith('diagnose-')) {
      const checks = mode === 'diagnose-missing-checks' ? [] : verification.checks;
      const receipts = mode === 'diagnose-actions-only'
        ? registry.receipts.filter(receipt => receipt.kind === 'browser-action' || receipt.kind === 'service-action') : registry.receipts;
      const judgment = await agent.tryTypesafeBatch({ result: verification, checks }, receipts);
      console.log(JSON.stringify({ realJudgment: true, available: Boolean(judgment), verdict: judgment?.b9?.value,
        failureKind: judgment?.failureKind, derivedEvidenceSubset: mode === 'diagnose-actions-only' || mode === 'diagnose-missing-checks',
        judgedChecks: judgment?.b11.size, checks: checks.length,
        unsupportedChecks: checks.flatMap((check, index) => (judgment?.b11.get(index) ?? -1) < 0.5
          ? [{ index, requirementIds: check.requirementIds, probability: judgment?.b11.get(index) }] : []),
        remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
      assert.deepEqual(await readFile(receiptPath), originalBytes, 'Diagnostics must not rewrite real execution evidence');
      assert.ok(judgment, 'Actual independent judgment unavailable');
      assert.equal(judgment.b11.size, mode === 'diagnose-global' ? 0 : checks.length);
      if (mode === 'diagnose-actions-only' || mode === 'diagnose-missing-checks') {
        assert.equal(judgment.b9.value, 'blocked', 'Missing execution evidence cannot approve acceptance or establish a product defect');
        if (mode === 'diagnose-actions-only') {
          assert.ok([...judgment.b11.values()].every(probability => probability < 0.5), 'Actions alone cannot support passing checks');
        }
      }
    } else {
      const result = await agent.rejudge(verification);
      const judgment = result?.judgment;
      console.log(JSON.stringify({ realJudgment: true, available: Boolean(judgment), verdict: judgment?.verdict,
        recoveredStatus: result?.status, reusedExecutionRun: result?.coverage?.runId === runId,
        judgedChecks: judgment?.checks.length, checks: verification.checks.length,
        unsupportedChecks: verification.checks.flatMap((check, index) => (judgment?.checks.find(item => item.index === index)?.probability ?? -1) < 0.5
          ? [{ index, requirementIds: check.requirementIds, probability: judgment?.checks.find(item => item.index === index)?.probability }] : []),
        remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
      assert.ok(judgment, 'Actual independent judgment unavailable');
      assert.equal(judgment.checks.length, verification.checks.length, 'Every existing acceptance check must receive a judgment');
      assert.equal(judgment.runId, runId);
      assert.deepEqual(await readFile(receiptPath), originalBytes, 'Recovery must not rewrite actual execution evidence');
    }
  } finally { setVerifyBehaviorFetchImpl(null); }
}
