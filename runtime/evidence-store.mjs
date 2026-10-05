import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

async function physicalPath(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await physicalPath(path.dirname(file)), path.basename(file));
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Receipts live outside product files, even when the configured state directory is in the checkout. */
export async function evidenceDirectory({ workdir, stateDir, repository, issueNumber, runId }) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 0 || !runPattern.test(runId ?? '')) throw new Error('Invalid evidence identity');
  const checkout = await fs.realpath(workdir);
  let root = stateDir ? await physicalPath(path.resolve(stateDir)) : undefined;
  if (!root || inside(checkout, root)) {
    try {
      const common = (await exec('git', ['rev-parse', '--git-common-dir'], { cwd: checkout })).stdout.trim();
      root = path.join(await fs.realpath(path.resolve(checkout, common)), 'factory-evidence');
    } catch {
      root = path.join(await fs.realpath(os.tmpdir()), 'factory-evidence', hash(checkout));
    }
  } else root = path.join(root, 'evidence');
  const physicalRoot = await physicalPath(root);
  if (path.relative(root, physicalRoot) !== '') throw new Error('Evidence storage root is a redirected path');
  const directory = path.join(root, hash(repository), String(issueNumber), runId);
  if (!inside(physicalRoot, await physicalPath(directory))) throw new Error('Evidence directory escaped its storage root');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await fs.realpath(directory);
  if (!inside(await fs.realpath(root), actual)) throw new Error('Evidence directory escaped its storage root');
  return actual;
}

/** Move only untracked files whose run and receipt identities match trusted factory checkpoints. */
export async function relocateLegacyEvidence(options, verifications) {
  const checkout = await fs.realpath(options.workdir);
  const legacy = path.join(checkout, 'evidence');
  const moved = [];
  for (const verification of verifications) {
    const runId = /^https:\/\/oz\.warp\.dev\/runs\/([a-f0-9-]{36})$/.exec(verification.ozRunUrl ?? '')?.[1];
    if (!runId || (verification.coverage?.runId && verification.coverage.runId !== runId)) continue;
    const source = path.join(legacy, runId);
    let stat;
    try { stat = await fs.lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(source) !== source) throw new Error('Legacy evidence path is not an owned directory');
    const destination = await evidenceDirectory({ ...options, runId });
    const fileNames = ['acceptance.json'];
    for (const artifact of verification.evidence ?? []) {
      const relative = artifact.path?.replace(/\\/g, '/');
      const match = new RegExp(`^evidence/${runId}/(browser-[0-9]+\\.png)$`).exec(relative ?? '');
      if (!match) throw new Error('Legacy evidence checkpoint has an unsupported file path');
      fileNames.push(match[1]);
    }
    let receiptFile = path.join(source, 'acceptance.json');
    try { await fs.lstat(receiptFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; receiptFile = path.join(destination, 'acceptance.json'); }
    const receiptInfo = await fs.lstat(receiptFile);
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error('Legacy receipt is not a regular owned file');
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (receipt.runId !== runId || receipt.issue !== options.issueNumber || !Array.isArray(receipt.receipts)
      || !Array.isArray(receipt.evidence)) throw new Error('Legacy evidence receipt identity mismatch');
    const receiptIds = new Set(receipt.receipts.map(item => item.id));
    if ((verification.checks ?? []).some(check => check.receiptIds.some(id => !receiptIds.has(id)))) {
      throw new Error('Legacy evidence is missing checkpoint receipts');
    }
    if (JSON.stringify(receipt.evidence) !== JSON.stringify(verification.evidence ?? [])) throw new Error('Legacy evidence file list differs from checkpoint');
    const names = [...new Set(fileNames)];
    const present = await fs.readdir(source);
    if (present.some(name => !names.includes(name))) throw new Error('Legacy evidence contains unowned files; no automatic migration');
    if ((await exec('git', ['ls-files', '-z', '--', ...names.map(name => `evidence/${runId}/${name}`)], { cwd: checkout })).stdout) {
      throw new Error('Tracked product files cannot be migrated as factory evidence');
    }
    for (const name of names) {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      const info = await fs.lstat(from).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!info) {
        const archived = await fs.lstat(to);
        if (!archived.isFile() || archived.isSymbolicLink()) throw new Error('Missing legacy evidence has no regular archived copy');
        continue; // A previous interrupted migration already confirmed this file.
      }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Legacy evidence file is not a regular owned file');
      const bytes = await fs.readFile(from);
      const targetInfo = await fs.lstat(to).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) throw new Error('Evidence destination is not a regular owned file');
      try { await fs.copyFile(from, to, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (hash(await fs.readFile(to)) !== hash(bytes)) throw new Error('Evidence destination conflict; original file preserved');
      if (hash(await fs.readFile(from)) !== hash(bytes)) throw new Error('Legacy evidence changed during migration; original file preserved');
      await fs.unlink(from); // A verified, byte-identical external copy remains recoverable.
      moved.push({ from, to, hash: hash(bytes) });
    }
    await fs.rmdir(source); // Non-recursive: never remove extra product or user files.
  }
  if (moved.length) await fs.rmdir(legacy).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
  return moved;
}
