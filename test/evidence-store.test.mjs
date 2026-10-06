import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { evidenceDirectory, relocateLegacyEvidence } from '../runtime/evidence-store.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-evidence-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-evidence-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const workdir = path.join(root, 'worktree');
  await fs.mkdir(workdir);
  await exec('git', ['init', '-b', 'main'], { cwd: workdir });
  await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '--allow-empty', '-m', 'Fixture'], { cwd: workdir });
  const options = { workdir, stateDir: path.join(root, 'runtime'), repository: 'owner/repo', issueNumber: 9 };
  const runId = randomUUID();
  const source = path.join(workdir, 'evidence', runId);
  const evidence = [{ kind: 'screenshot', caption: 'Runtime artifact', path: `evidence/${runId}/browser-0.png` }];
  const verification = { ozRunUrl: `https://oz.warp.dev/runs/${runId}`, evidence, checks: [{ receiptIds: ['factory-receipt'] }] };
  const receipt = { runId, issue: 9, evidence, receipts: [{ id: 'factory-receipt', passed: true }] };
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'acceptance.json'), JSON.stringify(receipt));
  await fs.writeFile(path.join(source, 'browser-0.png'), 'screenshot bytes');
  return { root, options, source, runId, verification, receipt };
}

test('artifact storage is external or Git metadata, not an untracked product directory', async t => {
  const { options, runId } = await fixture(t);
  await fs.rm(path.join(options.workdir, 'evidence'), { recursive: true });
  const external = await evidenceDirectory({ ...options, runId });
  assert.ok(external.startsWith(options.stateDir + path.sep));
  const metadata = await evidenceDirectory({ ...options, stateDir: path.join(options.workdir, '.factory'), runId });
  assert.ok(metadata.startsWith(path.join(options.workdir, '.git', 'factory-evidence') + path.sep));
  await fs.writeFile(path.join(metadata, 'acceptance.json'), '{}');
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: options.workdir })).stdout.trim(), '');
  await assert.rejects(evidenceDirectory({ ...options, runId: '../escape' }), /identity/);
  await assert.rejects(evidenceDirectory({ ...options, issueNumber: -1, runId }), /identity/);
});

test('trusted legacy files migrate losslessly and repeated migration is harmless', async t => {
  const { options, source, runId, verification } = await fixture(t);
  const bytes = await fs.readFile(path.join(source, 'acceptance.json'));
  const moved = await relocateLegacyEvidence(options, [verification]);
  assert.equal(moved.length, 2);
  const destination = await evidenceDirectory({ ...options, runId });
  assert.deepEqual(await fs.readFile(path.join(destination, 'acceptance.json')), bytes);
  assert.equal(await fs.readFile(path.join(destination, 'browser-0.png'), 'utf8'), 'screenshot bytes');
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: options.workdir })).stdout.trim(), '');
  assert.deepEqual(await relocateLegacyEvidence(options, [verification]), []);
});

test('default temporary storage accepts an OS path alias but still rejects redirected evidence', async t => {
  const { root } = await fixture(t);
  const workdir = path.join(root, 'non-git-project');
  const temporary = path.join(root, 'system-temp');
  const alias = path.join(root, 'temp-alias');
  const outside = path.join(root, 'outside-temp');
  await fs.mkdir(workdir);
  await fs.mkdir(temporary);
  await fs.mkdir(outside);
  await fs.symlink(temporary, alias, 'junction');
  const values = { TEMP: alias, TMP: alias, TMPDIR: alias };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  try {
    assert.equal(await fs.realpath(os.tmpdir()), await fs.realpath(temporary));
    const options = { workdir, stateDir: path.join(workdir, '.factory'),
      repository: 'local/temp-alias', issueNumber: 1, runId: randomUUID() };
    const redirected = path.join(temporary, 'factory-evidence');
    await fs.symlink(outside, redirected, 'junction');
    await assert.rejects(evidenceDirectory(options), /redirected/);
    assert.deepEqual(await fs.readdir(outside), [], 'A redirected evidence root must not receive files');
    await fs.unlink(redirected);
    const directory = await evidenceDirectory(options);
    assert.ok(directory.startsWith(path.join(await fs.realpath(temporary), 'factory-evidence') + path.sep));
    assert.equal((await fs.readdir(workdir)).length, 0, 'Evidence must not dirty the product');
  } finally {
    Object.keys(values).forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
    await fs.unlink(alias);
  }
});

test('partial relocation resumes from archived receipt without overwriting conflicting data', async t => {
  const { options, source, runId, verification } = await fixture(t);
  const destination = await evidenceDirectory({ ...options, runId });
  await fs.writeFile(path.join(destination, 'browser-0.png'), 'conflicting bytes');
  await assert.rejects(relocateLegacyEvidence(options, [verification]), /destination conflict/);
  assert.equal(await fs.readFile(path.join(source, 'browser-0.png'), 'utf8'), 'screenshot bytes');
  assert.equal(await fs.readFile(path.join(destination, 'browser-0.png'), 'utf8'), 'conflicting bytes');
  await fs.writeFile(path.join(destination, 'browser-0.png'), 'screenshot bytes');
  assert.equal((await relocateLegacyEvidence(options, [verification])).length, 1);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: options.workdir })).stdout.trim(), '');
});

for (const kind of ['unowned', 'tracked', 'wrong-issue', 'wrong-receipt', 'wrong-evidence']) {
  test(`legacy migration refuses ${kind} files without deleting product data`, async t => {
    const { options, source, verification, receipt } = await fixture(t);
    if (kind === 'unowned') await fs.writeFile(path.join(source, 'user-code.ts'), 'product data');
    if (kind === 'tracked') await exec('git', ['add', 'evidence'], { cwd: options.workdir });
    if (kind === 'wrong-issue') receipt.issue = 10;
    if (kind === 'wrong-receipt') receipt.receipts[0].id = 'other';
    if (kind === 'wrong-evidence') receipt.evidence = [];
    await fs.writeFile(path.join(source, 'acceptance.json'), JSON.stringify(receipt));
    await assert.rejects(relocateLegacyEvidence(options, [verification]));
    assert.ok(await fs.stat(path.join(source, 'acceptance.json')));
    assert.equal(await fs.readFile(path.join(source, 'browser-0.png'), 'utf8'), 'screenshot bytes');
  });
}

test('unknown evidence directories and redirected storage never gain ownership by name', async t => {
  const { root, options, source, runId } = await fixture(t);
  assert.deepEqual(await relocateLegacyEvidence(options, []), []);
  assert.ok(await fs.stat(path.join(source, 'acceptance.json')));
  const outside = path.join(root, 'outside');
  const redirected = path.join(root, 'redirected');
  await fs.mkdir(outside);
  await fs.mkdir(redirected);
  await fs.symlink(outside, path.join(redirected, 'evidence'), 'junction');
  await assert.rejects(evidenceDirectory({ ...options, stateDir: redirected, runId }), /redirected/);
});
