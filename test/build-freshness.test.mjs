import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { factoryInputHash, writeFactoryBuildManifest, assertFreshFactoryBuild } from '../runtime/build-freshness.mjs';

test('factory build rejects source drift, altered bundles and missing certification', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'dist/factory'), {recursive:true});
  await fs.writeFile(path.join(root, 'src/main.ts'), 'original');
  for (const name of ['orchestrator.js','run-issue.js','agent-runtime.js']) await fs.writeFile(path.join(root, 'dist/factory',name), 'compiled');
  await assert.rejects(assertFreshFactoryBuild(root), {code:'FACTORY_BUILD_STALE'});
  const hash = await factoryInputHash(root);
  await writeFactoryBuildManifest(root, hash);
  await assertFreshFactoryBuild(root);
  await fs.writeFile(path.join(root, 'src/main.ts'), 'changed');
  await assert.rejects(assertFreshFactoryBuild(root), {code:'FACTORY_BUILD_STALE'});
  await assert.rejects(writeFactoryBuildManifest(root, hash), /sources changed during build/);
  await fs.writeFile(path.join(root, 'src/main.ts'), 'original');
  await fs.writeFile(path.join(root, 'dist/factory/run-issue.js'), 'changed');
  await assert.rejects(assertFreshFactoryBuild(root), {code:'FACTORY_BUILD_STALE'});
});
