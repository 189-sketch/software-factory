// Capture the actual review-pr judgment request over trusted data; never persist a review or merge.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../../runtime/github-rest.mjs';
import { ReviewPrAgent, setReviewPrFetchImpl } from '../../src/agents/review-pr.ts';
import { annotateDiff } from '../../src/orchestrator/review-artifacts.ts';
import { hasSpecificationApproval } from '../../runtime/completion-contract.mjs';
import { projectReviewDiff, reviewGenerationEvidence } from '../../runtime/review-judgment-context.mjs';

const [repository, numberText, stateDir, workdir, mode = 'diagnose', envFile] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && workdir && Number.isSafeInteger(number) && number > 0);
assert.ok(['diagnose', 'verify', 'judge', 'judge-baseline'].includes(mode));
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
  assert.ok(state?.review && state.specs && hasSpecificationApproval(state));
  const before = structuredClone(state);
  const diff = execFileSync('git', ['diff', '--unified=3', `${state.reviewedBaseSha}...${state.implementation.commitSha}`],
    { cwd: workdir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.ok(diff.trim());
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const context = { issue: state.issue, repo: { workdir, defaultBranch: 'main' }, logger };
  const agent = new ReviewPrAgent(context, {
    specs: state.specs, approved: hasSpecificationApproval(state),
    headSha: state.implementation.commitSha, baseSha: state.reviewedBaseSha,
  });
  const savedKey = process.env.TYPESAFE_API_KEY, savedOff = process.env.FACTORY_TYPESAFE_OFF;
  process.env.TYPESAFE_API_KEY = 'request-capture-not-a-credential';
  delete process.env.FACTORY_TYPESAFE_OFF;
  let request;
  setReviewPrFetchImpl(async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response('{}', { status: 503 });
  });
  try { assert.equal(await agent.tryTypesafeBatch(annotateDiff(diff), state.review), null); }
  finally {
    setReviewPrFetchImpl(null);
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
    if (savedOff === undefined) delete process.env.FACTORY_TYPESAFE_OFF; else process.env.FACTORY_TYPESAFE_OFF = savedOff;
  }
  assert.ok(request);
  console.log(JSON.stringify({ issue: number, revision: state.revision,
    packetBytes: Buffer.byteLength(JSON.stringify(request.state)), diffBytes: Buffer.byteLength(diff),
    componentBytes: Object.fromEntries(Object.entries(request.state).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])),
    productFieldBytes: Object.fromEntries(Object.entries(state.specs.product).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])),
    specificationPresent: Boolean(request.state.specification), unknownPRCountWrittenAsZero: request.state.repoSignals?.hasOpenPRs === 0,
    findings: state.review.findings?.length, questionCount: Object.keys(request.questions).length,
    persistedReviewConfidence: state.review.confidence, providerCalls: 0, remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  assert.deepEqual(state, before);
  if (mode === 'diagnose' || mode === 'judge-baseline') {
    assert.equal(request.state.specification, undefined);
    assert.equal(request.state.repoSignals?.hasOpenPRs, 0);
  } else {
    assert.equal(request.state.repoSignals, undefined);
    assert.equal(request.state.specification.approved, true);
    assert.equal(request.state.specification.commitSha, state.specs.commitSha);
    assert.deepEqual(request.state.specification.product.acceptanceCriteria, state.specs.product.acceptanceCriteria);
    assert.deepEqual(request.state.reviewFindings, state.review.findings);
    const projection = projectReviewDiff(diff, reviewGenerationEvidence(state.review));
    assert.equal(request.state.prDiff, projection.prDiff);
    assert.deepEqual(request.state.changeInventory, projection.changeInventory);
    console.log(JSON.stringify({ includedCodeBytes: Buffer.byteLength(projection.prDiff),
      changedFiles: projection.changeInventory.length, includedFiles: projection.changeInventory.filter(item => item.included).length,
      missingReferencedPaths: projection.missingReferencedPaths.length }));
  }
  if (mode === 'judge' || mode === 'judge-baseline') {
    assert.ok(envFile); process.loadEnvFile(envFile); assert.ok(process.env.TYPESAFE_API_KEY);
    request.model = process.env.FACTORY_TYPESAFE_MODEL || request.model;
    const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
    const result = await response.json();
    if (response.status !== 200) {
      const error = result.error ?? result;
      console.log(JSON.stringify({ status: response.status, errorKeys: Object.keys(error),
        code: /^[a-z0-9_-]+$/i.test(error.code ?? '') ? error.code : undefined,
        tokenLimitMentioned: /token|context|length/i.test(JSON.stringify(error)),
        maxTokensExceeded: JSON.stringify(error).includes('max_tokens_exceeded'),
        numericDetails: JSON.stringify(error).match(/\b\d{3,}\b/g)?.slice(0, 10), providerCalls: 1, remoteWrites: 0 }));
    }
    assert.equal(response.status, 200);
    assert.equal(Object.keys(result.answers).length, Object.keys(request.questions).length);
    const headline = result.answers.B7;
    assert.ok(headline?.type === 'choice');
    console.log(JSON.stringify({ requestBytes: Buffer.byteLength(JSON.stringify(request)), model: result.model,
      judgment: { choice: headline.choice, confidence: headline.confidence, probabilities: headline.probabilities }, usage: result.usage,
      providerCalls: 1, remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  }
} finally { closeSharedAgent(); }
