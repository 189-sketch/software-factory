import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { judgmentResumeStage } from '../runtime/judgment-recovery.mjs';

const workflowDirectory = path.resolve("templates/github/workflows");

test('daemon admits missing judgment before freshness can return an unchanged wait', async () => {
  const body = await fs.readFile(path.resolve('scripts/factory-daemon.mjs'), 'utf8');
  const start = body.indexOf('        const judgmentStage = judgmentResumeStage(issue._checkpoint);');
  const end = body.indexOf('        let freshnessResult;', start);
  assert.ok(start > 0 && end > start);
  const checkpoint = { status: 'waiting', nextLabel: 'verified', issue: { state: 'open' },
    implementation: { commitSha: 'sha' }, reviewedSha: 'sha', review: { verdict: 'APPROVE' } };
  const scope = { judgmentResumeStage, issue: { number: 123, _checkpoint: checkpoint },
    readyIssues: [], freshnessOutcomes: [], log() {} };
  vm.runInNewContext(`for (const _ of [0]) { ${body.slice(start, end)} }`, scope);
  assert.equal(scope.readyIssues.length, 1);
  assert.equal(scope.readyIssues[0].__resumeStage, 'review');
  assert.equal(scope.freshnessOutcomes[0].skipped, false);
});

test('daemon worker receives resolved validation configuration without unrelated secrets', async () => {
  const body = await fs.readFile(path.resolve('scripts/factory-daemon.mjs'), 'utf8');
  const builder = body.slice(body.indexOf('function buildChildEnv('), body.indexOf('function parseArgs('));
  const environment = body.match(/  const env = buildChildEnv\("node", \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(environment, 'worker environment construction must be exercised');
  const scope = {
    process: { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
      FACTORY_VERIFY_COMMAND: 'unresolved command', UNRELATED_SECRET: 'never-forward' } },
    FACTORY_CONFIG: { state: { writers: [] }, autoMerge: false,
      daemon: { infrastructureRetryBaseMs: 3000, infrastructureRetryMaxMs: 9000 },
      limits: { commandTimeoutMs: 600000 },
      paths: { reviewDir: path.resolve('review-artifacts') },
      verify: { command: 'node check.js', url: 'http://127.0.0.1:5178' } },
    lease: null, agentConfigEnv: {},
  };
  for (const key of ['AGENT_MODE', 'defaultBranch', 'STATE_DIR', 'LOCAL_DIR', 'FACTORY_GH_REPO', 'GH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_MAX_TOKENS',
    'FACTORY_TRUSTED_EXECUTION', 'FACTORY_SYNC_LABELS', 'FACTORY_SYNC_PROJECTS']) scope[key] = '';
  const env = vm.runInNewContext(`${builder}\n${environment}\nenv`, scope);
  const observed = JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify({command:process.env.FACTORY_VERIFY_COMMAND??null,url:process.env.FACTORY_VERIFY_URL??null,reviewDir:process.env.FACTORY_REVIEW_DIR??null,commandTimeout:process.env.FACTORY_COMMAND_TIMEOUT_MS??null,retryBase:process.env.FACTORY_INFRA_RETRY_BASE_MS??null,retryMax:process.env.FACTORY_INFRA_RETRY_MAX_MS??null,leaked:!!process.env.UNRELATED_SECRET}))'],
  { env, encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(observed, { command: scope.FACTORY_CONFIG.verify.command, url: scope.FACTORY_CONFIG.verify.url,
    reviewDir: scope.FACTORY_CONFIG.paths.reviewDir, commandTimeout: '600000', retryBase: '3000', retryMax: '9000', leaked: false });
});

test('daemon resumes whole issue workflows and releases claims outside standalone-stage guards', async () => {
  const body = await fs.readFile(path.resolve('scripts/factory-daemon.mjs'), 'utf8');
  assert.doesNotMatch(body, /RESUME_TO_CLI_STAGE|enqueueIssue\(cleaned, /);
  assert.match(body, /const dispatch = enqueueIssue\(cleaned\);/);
  assert.match(body, /await releaseIssueClaim\(issue, exitCode === 0\);\s+if \(!stage\)/);
  assert.match(body, /classifyPipelineOutcome\(exitCode, summary, stage\)/);
});

async function workflow(name) {
  return fs.readFile(path.join(workflowDirectory, name), "utf8");
}

test('daemon admits verified executor upgrades before semantic freshness may park unchanged business input', async () => {
  const body = await fs.readFile(path.resolve('scripts/factory-daemon.mjs'), 'utf8');
  const admission = body.indexOf('if (needsVerificationCapabilityRecovery(issue._checkpoint))');
  const freshness = body.indexOf('freshnessResult = await freshnessCheck');
  assert.ok(admission >= 0 && admission < freshness);
  assert.match(body.slice(admission, freshness), /verification\.capability-recovery/);
  assert.match(body.slice(admission, freshness), /__resumeStage: 'verify'/);
});

test("every workflow scheduler that invokes the factory holds and releases a lease", async () => {
  const names = [
    "triage-issues.yml",
    "spec-ready-issues.yml",
    "implement-ready-issues.yml",
    "review-pull-requests.yml",
    "improve-review-pr.yml",
  ];

  for (const name of names) {
    const body = await workflow(name);
    const acquire = body.indexOf("factory-lease.mjs acquire");
    const execute = body.indexOf("dist/factory/run-issue.js");
    const release = body.indexOf("factory-lease.mjs release");
    assert.ok(acquire >= 0 && acquire < execute, `${name} must acquire before execution`);
    assert.ok(release > execute, `${name} must release after execution`);
    assert.match(body, /if: always\(\) && steps\.lease\.outcome == 'success'/, `${name} must release on failures`);
  }
});

test("workflow runtime and merge policy match the package contract", async () => {
  const names = await fs.readdir(workflowDirectory);
  for (const name of names.filter((entry) => entry.endsWith(".yml"))) {
    assert.doesNotMatch(await workflow(name), /node-version:\s*["']?20\b/, `${name} uses unsupported Node 20`);
  }

  for (const name of ["spec-ready-issues.yml", "implement-ready-issues.yml"]) {
    assert.match(
      await workflow(name),
      /FACTORY_AUTO_MERGE:\s*\$\{\{ vars\.FACTORY_AUTO_MERGE \|\| '0' \}\}/,
      `${name} must default auto merge off`,
    );
  }
});
