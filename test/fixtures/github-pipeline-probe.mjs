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
  FACTORY_AUTO_MERGE: '0', FACTORY_SYNC_LABELS: '1', FACTORY_SYNC_PROJECTS: '0',
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
if (mode === 'rubric-only') {
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
