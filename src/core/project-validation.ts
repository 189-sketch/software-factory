import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const engineeringScripts = ['test', 'typecheck', 'lint', 'build', 'format:check'];

export interface ProjectValidationPlan {
  baselineSha: string;
  checks: { program: string; args: string[]; cwd: string; source: string }[];
  notes: string[];
}

/** Discover declared npm checks from the pre-edit Git baseline, not model claims. */
export async function discoverProjectValidation(workdir: string): Promise<ProjectValidationPlan> {
  const git = async (...args: string[]) => (await exec('git', args, { cwd: workdir, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const baselineSha = (await git('rev-parse', 'HEAD')).trim();
  const files = (await git('ls-tree', '-r', '-z', '--name-only', baselineSha)).split('\0').filter(Boolean);
  const plan: ProjectValidationPlan = { baselineSha, checks: [], notes: [] };
  for (const file of files) {
    if (path.posix.basename(file) !== 'package.json' || file.split('/').some(segment =>
      ['node_modules', '.git', '.factory', '.factory-daemon'].includes(segment))) continue;
    const cwd = path.posix.dirname(file);
    let manifest: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(await git('show', `${baselineSha}:${file}`));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifest must be an object');
      manifest = value as Record<string, unknown>;
    } catch {
      plan.notes.push(`${file}: invalid baseline manifest; implementation must repair it`);
      plan.checks.push({ program: 'node', args: ['-e', "const v=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));if(!v||typeof v!=='object'||Array.isArray(v))process.exit(1)", file], cwd: '.', source: `${file}:manifest` });
      continue;
    }
    const manager = typeof manifest.packageManager === 'string' ? manifest.packageManager : '';
    const engines = manifest.engines as Record<string, unknown> | undefined;
    const npmDeclared = manager ? manager.startsWith('npm@')
      : typeof engines?.npm === 'string' || files.includes(path.posix.join(cwd, 'package-lock.json'));
    if (!npmDeclared) {
      plan.notes.push(`${file}: npm ownership not established; language/CI adapter discovery remains required`);
      continue;
    }
    const scripts = manifest.scripts as Record<string, unknown> | undefined;
    for (const script of engineeringScripts) {
      if (typeof scripts?.[script] !== 'string' || !scripts[script].trim()) continue;
      plan.checks.push({ program: 'npm', args: ['run', script], cwd, source: `${file}:scripts.${script}` });
    }
  }
  return plan;
}
