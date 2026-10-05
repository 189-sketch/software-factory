import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCiValidation } from '../core/ci-validation.js';
import type { ProjectValidationPlan } from '../core/project-validation.js';
import { classifyError } from '../core/failure-classifier.js';

function discover(body: string): ProjectValidationPlan {
  const plan: ProjectValidationPlan = { baselineSha: 'baseline', checks: [], notes: [], sources: [], blockers: [], ciJobs: [] };
  discoverCiValidation('.github/workflows/quality.yaml', body, plan);
  return plan;
}

test('CI discovers custom gates and preserves directory precedence, matrix, runtime and conditions', () => {
  const plan = discover(`
on: [push, pull_request]
defaults:
  run: { working-directory: root }
jobs:
  quality:
    if: github.event_name == 'pull_request'
    runs-on: "\${{ matrix.os }}"
    strategy:
      matrix: { os: [ubuntu-latest, windows-latest], node: ['22.19.0', '24.15.0'] }
    defaults:
      run: { working-directory: "web app", shell: bash }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "\${{ matrix.node }}" }
      - run: npm ci
      - run: npm run unusual-quality-alias
        if: matrix.os == 'ubuntu-latest'
        continue-on-error: true
      - run: node "checks/regression probe.js"
        working-directory: .
  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: python -m unittest discover
  rust:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test --locked
        working-directory: crates/service
  go:
    runs-on: ubuntu-latest
    steps:
      - run: go test ./...
        working-directory: service
`);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.checks.map(({ program, args, cwd }) => ({ program, args, cwd })), [
    { program: 'npm', args: ['ci'], cwd: 'web app' },
    { program: 'npm', args: ['run', 'unusual-quality-alias'], cwd: 'web app' },
    { program: 'node', args: ['checks/regression probe.js'], cwd: '.' },
    { program: 'python', args: ['-m', 'unittest', 'discover'], cwd: 'root' },
    { program: 'cargo', args: ['test', '--locked'], cwd: 'crates/service' },
    { program: 'go', args: ['test', './...'], cwd: 'service' },
  ]);
  assert.deepEqual(plan.ciJobs[0]!.matrix, { os: ['ubuntu-latest', 'windows-latest'], node: ['22.19.0', '24.15.0'] });
  assert.equal(plan.ciJobs[0]!.runtimes[0]!.version, '${{ matrix.node }}');
  assert.deepEqual(plan.ciJobs[0]!.trigger, ['push', 'pull_request']);
  assert.deepEqual(plan.ciJobs[0]!.steps[1]!.condition, { job: "github.event_name == 'pull_request'", step: "matrix.os == 'ubuntu-latest'" });
  assert.deepEqual(plan.ciJobs[0]!.steps[1]!.continueOnError, { job: false, step: true });
});

test('multi-line literal commands are admitted atomically without dropping shell state changes', () => {
  const valid = discover('jobs:\n  check:\n    steps:\n      - run: |\n          npm ci\n          npm test\n');
  assert.equal(valid.checks.length, 2);
  const invalid = discover('jobs:\n  check:\n    steps:\n      - run: |\n          npm test\n          cd elsewhere\n          npm run lint\n');
  assert.equal(invalid.checks.length, 0);
  assert.equal(invalid.blockers.length, 1);
});

test('dynamic, external, unsafe and context-dependent gates are visible blockers, never invented passes', () => {
  for (const step of [
    'run: npm test && npm run lint',
    'run: npm test --flag=$FLAG',
    'run: npm test --flag=%FLAG%',
    'run: npm run deploy',
    'run: terraform apply',
    'run: npm test\n        working-directory: ../outside',
    'run: npm test\n        working-directory: "${{ matrix.path }}"',
    'run: npm test\n        env: { API_TOKEN: "${{ secrets.TOKEN }}" }',
    'uses: unknown/quality-action@v1',
    'run: npm test\n        shell: python',
    'run: node "unfinished',
  ]) {
    const plan = discover(`jobs:\n  check:\n    steps:\n      - ${step}\n`);
    assert.equal(plan.checks.length, 0, step);
    assert.ok(plan.blockers.length > 0, step);
    assert.ok(plan.blockers.every(item => item.source.startsWith('.github/workflows/quality.yaml')));
    assert.ok(!JSON.stringify(plan.blockers).includes('API_TOKEN'), 'diagnostics do not echo environment values');
  }
  assert.equal(classifyError({ code: 'FACTORY_PROJECT_VALIDATION_UNRESOLVED', message: 'missing gate' }).class, 'USER_INPUT_REQUIRED');
});

test('malformed, duplicate and cyclic CI YAML cannot silently become an empty successful plan', () => {
  for (const body of ['jobs: [', 'jobs: {}', 'jobs: {}\njobs: {}', 'jobs: &jobs\n  self: *jobs']) {
    const plan = discover(body);
    assert.equal(plan.checks.length, 0);
    assert.ok(plan.blockers.length > 0);
  }
});

test('CI relocation, declared environment, containers, services and artifact inputs retain missing prerequisites', () => {
  for (const addition of [
    'env: { MODE: test }', 'container: node:22', 'services: { db: { image: postgres } }',
  ]) {
    const plan = discover(`jobs:\n  check:\n    ${addition}\n    steps:\n      - run: npm test\n`);
    assert.equal(plan.checks.length, 0);
    assert.ok(plan.blockers.length > 0);
  }
  const plan = discover('jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v4\n        with: { path: nested }\n      - uses: actions/download-artifact@v4\n      - run: npm test\n');
  assert.equal(plan.checks.length, 0);
  assert.equal(plan.blockers.length, 2);
});
