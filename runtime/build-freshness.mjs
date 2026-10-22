import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const inputs = ['src', 'runtime', 'skills', 'scripts', 'templates', 'package.json', 'package-lock.json', 'tsconfig.json'];
const outputs = ['orchestrator.js', 'run-issue.js', 'agent-runtime.js'];

export async function factoryInputHash(root) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const file = path.join(root, relative);
    const stat = await fs.stat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      hash.update(relative).update('\0').update(createHash('sha256').update(await fs.readFile(file)).digest());
    }
  }
  for (const relative of inputs) await visit(relative);
  return hash.digest('hex');
}

async function outputHashes(root) {
  return Object.fromEntries(await Promise.all(outputs.map(async name => [name,
    createHash('sha256').update(await fs.readFile(path.join(root, 'dist/factory', name))).digest('hex')])));
}

export async function writeFactoryBuildManifest(root, inputHash) {
  // A source edit during the build must never be certified as compiled.
  if (await factoryInputHash(root) !== inputHash) throw new Error('Factory sources changed during build; rebuild before starting');
  const manifest = { version: 1, inputHash, outputs: await outputHashes(root) };
  await fs.writeFile(path.join(root, 'dist/factory/build-manifest.json'), JSON.stringify(manifest));
}

export async function assertFreshFactoryBuild(root) {
  if (!await fs.stat(path.join(root, 'dist/factory/run-issue.js')).catch(() => null)) return;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/factory/build-manifest.json'), 'utf8'));
    if (manifest.version !== 1) throw new Error('unsupported build manifest');
    const actual = await outputHashes(root);
    if (outputs.some(name => actual[name] !== manifest.outputs?.[name])) throw new Error('bundle content changed');
    // Published packages do not contain the development source tree.
    if (await fs.stat(path.join(root, 'src')).catch(() => null)
      && await factoryInputHash(root) !== manifest.inputHash) throw new Error('source differs from compiled build');
  } catch (cause) {
    throw Object.assign(new Error('Factory build is stale or unverified. Run npm run build before starting the daemon.', { cause }),
      { code: 'FACTORY_BUILD_STALE' });
  }
}
