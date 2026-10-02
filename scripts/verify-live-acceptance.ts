import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../runtime/github-rest.mjs';
import { VerifyBehaviorAgent } from '../src/agents/verify-behavior.js';
import { hasAcceptanceCoverage } from '../src/core/completion-contract.js';
import { ConsoleLogger } from '../src/core/log.js';
import type { FactoryIssueState, AgentContext } from '../src/core/types.js';

// Explicit opt-in real-project verification. Does not change GitHub state.
const [workdir, repository, issueNumber, envFile] = process.argv.slice(2);
if (!workdir || !repository || !/^\d+$/.test(issueNumber ?? '')) {
  throw new Error('Usage: node --import tsx scripts/verify-live-acceptance.ts <checkout> <owner/repo> <issue> [env-file]');
}
if (envFile) process.loadEnvFile(envFile);
const authEnv = { ...process.env };
delete authEnv.GH_TOKEN;
delete authEnv.GITHUB_TOKEN;
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', env: authEnv }).trim();
process.env.GH_TOKEN = token;
process.env.GITHUB_TOKEN = token;
const [owner, name] = repository.split('/');
try {
  const store = new GitHubStateStore({ repository, token, stateDir: path.join(path.dirname(path.resolve(workdir)), 'live-acceptance-state') });
  const state = await store.load(Number(issueNumber)) as FactoryIssueState | undefined;
  if (!state?.specs || !state.implementation?.commitSha) throw new Error('No recorded specification and implementation');
  const sha = state.implementation.commitSha;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
  if (head !== sha) throw new Error('Checkout does not match recorded implementation');
  const ctx: AgentContext = {
    repo: { owner, name, defaultBranch: 'main', workdir: path.resolve(workdir) },
    issue: state.issue, logger: new ConsoleLogger({ verification: 'live-acceptance' }),
    skills: [], skillsRoot: path.resolve('skills'), runId: `live-acceptance-${Date.now()}`,
  };
  const result = await new VerifyBehaviorAgent(ctx, 'verify', { spec: state.specs, implementationSha: sha }).run();
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: workdir, stdio: 'pipe' });
  const covered = hasAcceptanceCoverage(state.specs, sha, result);
  console.log(JSON.stringify({ status: result.status, covered, required: state.specs.product.acceptanceCriteria.length,
    checks: result.checks?.map(check => ({ requirementIds: check.requirementIds, passed: check.passed, receiptCount: check.receiptIds.length })),
    runId: ctx.runId, notes: result.notes }, null, 2));
  if (result.status !== 'verified' || !covered) process.exitCode = 1;
} finally {
  await closeSharedAgent();
}
