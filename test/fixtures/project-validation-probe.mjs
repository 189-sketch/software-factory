import assert from 'node:assert/strict';
import path from 'node:path';
import { discoverProjectValidation } from '../../src/core/project-validation.ts';
import { defaultTools } from '../../src/core/tools.ts';

// Explicit opt-in: use an isolated real project checkout, never a live worker's directory.
const workdir = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass an isolated project checkout');
const timeoutMs = Number(process.argv[3] ?? 600000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000);
const plan = await discoverProjectValidation(workdir);
assert.deepEqual(plan.blockers, [], 'Unresolved checks must not be reported as successful validation');
assert.ok(plan.checks.length > 0, 'No independent checks discovered');
console.log(JSON.stringify({ event: 'validation-discovered', baselineSha: plan.baselineSha,
  checks: plan.checks, sources: plan.sources, ciJobs: plan.ciJobs, notes: plan.notes }));
const priorTrust = process.env.FACTORY_TRUSTED_EXECUTION;
process.env.FACTORY_TRUSTED_EXECUTION = '1';
try {
  const context = { repo: { workdir }, commandTimeoutMs: timeoutMs };
  const execute = defaultTools(context).find(tool => tool.name === 'run_process');
  for (const { source, ...request } of plan.checks) {
    const started = Date.now();
    const result = await execute.execute(request, context);
    console.log(JSON.stringify({ event: 'validation-executed', source, request, exitCode: result.exitCode,
      timedOut: result.timedOut ?? false, durationMs: Date.now() - started,
      summary: `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(line => /passed|failed|vulnerabilit|Test Files|Tests\s/.test(line)).slice(-8) }));
    assert.equal(result.exitCode, 0, `${source}: ${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  }
  console.log(JSON.stringify({ event: 'validation-complete', baselineSha: plan.baselineSha, checks: plan.checks.length,
    proofScope: 'local engineering checks only; not full CI matrix or business acceptance', remoteStateWrites: 0 }));
} finally {
  if (priorTrust === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
  else process.env.FACTORY_TRUSTED_EXECUTION = priorTrust;
}
