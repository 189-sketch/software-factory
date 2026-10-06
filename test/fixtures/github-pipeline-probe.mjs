// Opt-in real GitHub/LLM integration. Never used by the offline test suite.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { fetchIssue } from '../../runtime/github-rest.mjs';

const [workdir, numberText, envFile, mode] = process.argv.slice(2);
const number = Number(numberText);
if (!workdir || !Number.isSafeInteger(number) || number < 1 || !envFile) throw new Error('Usage: probe <dedicated-checkout> <issue-number> <env-file>');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
process.loadEnvFile(envFile);
Object.assign(process.env, {
  GH_TOKEN: token, FACTORY_GH_REPO: '189-sketch/software-factory-demo',
  FACTORY_LOCAL_DIR: '', FACTORY_ISSUE_LEASE_SHA: '', FACTORY_STATE_WRITERS: '',
  FACTORY_STATE_DIR: path.join(path.dirname(workdir), 'r3-runtime'),
  FACTORY_REVIEW_DIR: path.join(path.dirname(workdir), 'r3-review-artifacts'),
  FACTORY_AUTO_MERGE: mode === 'auto' ? '1' : '0', FACTORY_SYNC_LABELS: '1', FACTORY_SYNC_PROJECTS: '0',
  FACTORY_TRUSTED_EXECUTION: '1', FACTORY_VERIFY_COMMAND: 'node bin/create-scaffold.js --help',
});
const config = resolveFactoryConfig({ cwd: workdir });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { FactoryOrchestrator } = await import('../../dist/factory/orchestrator.js');
const orchestrator = new FactoryOrchestrator({ config,
  skillsRoot: path.join(root, 'dist/factory/skills'),
  repo: { owner: '189-sketch', name: 'software-factory-demo', defaultBranch: 'main', workdir: path.resolve(workdir) },
  remotePath: 'https://github.com/189-sketch/software-factory-demo.git',
});
const issue = await fetchIssue({ repository: config.github.repository, token, number });
if (mode === 'reentry-only') {
  const assert = (await import('node:assert/strict')).default;
  const { access } = await import('node:fs/promises');
  const { listLeaseRefs } = await import('../../runtime/github-rest.mjs');
  const before = await orchestrator.store.load(number);
  assert.equal(before?.issue.state, 'closed');
  assert.equal(before?.status, 'completed');
  orchestrator.context = async () => { throw new Error('Completed issue must not start an agent'); };
  const result = await orchestrator.runForIssue(issue);
  assert.equal(result.revision, before.revision);
  assert.equal(result.merged, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.wait, undefined);
  assert.equal(result.nextLabel, undefined);
  assert.ok((result.externalOps ?? []).every(op => !['pending', 'in-flight', 'unknown', 'blocked'].includes(op.status)));
  assert.deepEqual(result.failureCounts, before.failureCounts);
  const leases = await listLeaseRefs({ repository: config.github.repository, token });
  assert.ok(!leases.some(lease => lease.issueNumber === number));
  await assert.rejects(access(path.join(config.paths.stateDir, 'recover', `${number}.json`)), { code: 'ENOENT' });
  console.log(JSON.stringify({ issue: number, revision: result.revision, status: result.status,
    noAgent: true, unchangedRevision: true, unresolvedOperations: 0, leaseReleased: true, uploadJournalCleared: true }));
} else if (mode === 'status-safe') {
  const current = await orchestrator.store.load(number);
  const result = current?.implementation?.behaviorVerification;
  const failure = result?.judgmentFailure;
  const { hasAcceptanceCoverage, hasImplementationApproval, hasVerificationJudgment } = await import('../../runtime/completion-contract.mjs');
  console.log(JSON.stringify({ issue: number, revision: current?.revision, status: current?.status,
    nextLabel: current?.nextLabel, merged: current?.merged, waitReason: current?.wait?.reason,
    reviewVerdict: current?.review?.verdict, verificationStatus: result?.status,
    judgmentFailure: failure ? { kind: failure.kind, code: failure.code, requestContractVersion: failure.requestContractVersion } : undefined,
    semanticJudgment: hasVerificationJudgment(result),
    acceptanceCoverage: current ? hasAcceptanceCoverage(current.specs, current.implementation?.commitSha, result) : false,
    implementationApproval: current ? hasImplementationApproval(current) : false,
    checks: result?.checks?.length, failedChecks: result?.checks?.filter(check => !check.passed).length,
    verificationAttempts: current?.verificationRecovery?.attempts,
    coveredRequirements: current?.verificationRecovery?.coveredRequirementIds?.length,
    executionRunId: result?.coverage?.runId,
    unresolvedOperations: current?.externalOps?.filter(op => ['pending', 'in-flight', 'unknown', 'blocked'].includes(op.status)).length,
    remoteWrites: 0, workerStarts: 0 }));
} else if (mode === 'status') {
  const current = await orchestrator.store.load(number);
  console.log(JSON.stringify({ revision: current?.revision, status: current?.status, nextLabel: current?.nextLabel,
    reviewedSha: current?.reviewedSha, verifiedSha: current?.verifiedSha,
    reviewVerdict: current?.review?.verdict, mergeRoute: current?.review?.mergeRoute,
    stages: current?.stages,
    verification: current?.implementation?.behaviorVerification,
    error: current?.error, lastFailure: current?.lastFailure, failureCounts: current?.failureCounts, wait: current?.wait,
    implementation: current?.implementation ? { branch: current.implementation.branch, commitSha: current.implementation.commitSha, prUrl: current.implementation.prUrl } : undefined }));
} else if (mode === 'verify-judgment-only') {
  const { readFile } = await import('node:fs/promises');
  const { VerifyBehaviorAgent } = await import('../../src/agents/verify-behavior.ts');
  const current = await orchestrator.store.load(number);
  const result = current?.implementation?.behaviorVerification;
  if (!result || current.verifiedSha !== current.implementation.commitSha) throw new Error('Judgment probe requires a verified current implementation');
  const runId = /\/runs\/([a-f0-9-]{36})$/.exec(result.ozRunUrl)?.[1];
  if (!runId) throw new Error('Judgment probe requires the factory-issued verification run id');
  const { evidenceDirectory } = await import('../../runtime/evidence-store.mjs');
  const external = await evidenceDirectory({ workdir, stateDir: config.paths.stateDir,
    repository: config.github.repository, issueNumber: number, runId });
  const evidence = JSON.parse(await readFile(result.receiptPath ?? path.join(external, 'acceptance.json'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(path.join(workdir, 'evidence', runId, 'acceptance.json'), 'utf8');
  }));
  if (evidence.issue !== number || evidence.runId !== runId) throw new Error('Receipt artifact does not belong to the current verification');
  const context = await orchestrator.context(current.issue, 'verify-behavior');
  const judgment = await new VerifyBehaviorAgent(context).tryTypesafeBatch({ result, checks: result.checks }, evidence.receipts);
  console.log(JSON.stringify({ b9: judgment?.b9, checks: judgment ? [...judgment.b11] : undefined }));
  process.exitCode = judgment ? 0 : 1;
} else if (mode === 'tool-bridge-only') {
  const { buildAgentRuntime } = await import('../../dist/factory/agent-runtime.js');
  const { defaultTools } = await import('../../src/core/tools.ts');
  const context = await orchestrator.context((await orchestrator.store.load(number)).issue, 'verify-behavior');
  const shell = defaultTools(context).find((tool) => tool.name === 'run_shell');
  let executed = false;
  const result = await buildAgentRuntime().runStage({ role: 'verify-behavior', runId: context.runId,
    issue: { number, repo: { workdir } }, inputManifest: {
      systemPrompt: 'Call the factory run_acceptance_test MCP tool once with command node -e "require(\'node:assert/strict\').ok(20 >= 10);console.log(\'bridge-ok\')". Then return {"passed":true} only if its real exitCode is zero. Do not fabricate a receipt.',
      messages: [{ role: 'user', content: 'Verify the real tool bridge.' }],
    }, tools: [{ name: 'run_acceptance_test', description: 'Args: {command:string}. Execute real assertions.',
      execute: async (args) => { const output = await shell.execute(args, context); executed = output.exitCode === 0 && output.stdout.includes('bridge-ok'); return output; },
    }],
  }, context);
  console.log(JSON.stringify({ status: result.status, executed, warnings: result.warnings }));
  process.exitCode = result.status === 'succeeded' && executed ? 0 : 1;
} else if (mode === 'rubric-only') {
  const { buildReviewRubricState, buildReviewRubricRequest } = await import('../../src/agents/spec-review-rubric.ts');
  const { reviewRubricInputFromSpec } = await import('../../src/core/spec-review-rubric.ts');
  const current = await orchestrator.store.load(number);
  if (!current?.specs) throw new Error('Rubric probe requires authoritative current specs');
  const input = reviewRubricInputFromSpec(current.specs, current.specReview?.findings);
  const request = buildReviewRubricRequest(buildReviewRubricState(current.issue, current.specs, input), input);
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
    body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  console.log(JSON.stringify({ status: response.status, questions: Object.keys(request.questions).length,
    bytes: Buffer.byteLength(JSON.stringify(request)), error: response.ok ? undefined : body.replaceAll(process.env.TYPESAFE_API_KEY, '[REDACTED]').slice(0, 1500) }));
  process.exitCode = response.ok ? 0 : 1;
} else if (mode === 'review-spec-only') {
  const { ReviewSpecAgent } = await import('../../src/agents/review-spec.ts');
  const current = await orchestrator.store.load(number);
  if (!current) throw new Error('Review-only probe requires an existing authoritative pipeline state');
  const context = await orchestrator.context(current.issue, 'review-spec');
  const result = await new ReviewSpecAgent(context).run();
  console.log(JSON.stringify({ issue: number, verdict: result.verdict, body: result.body }));
} else {
const result = await orchestrator.runForIssue(issue);
console.log(JSON.stringify({ issue: number, revision: result.revision, status: result.status, nextLabel: result.nextLabel,
  merged: result.merged, prUrl: result.implementation?.prUrl, wait: result.wait }));
}
