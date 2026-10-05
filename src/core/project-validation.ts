import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { discoverCiValidation } from './ci-validation.js';

const exec = promisify(execFile);
const engineeringScripts = ['test', 'typecheck', 'lint', 'build', 'format:check'];

export interface ProjectValidationPlan {
  baselineSha: string;
  primaryLanguage?: string;
  checks: { program: string; args: string[]; cwd: string; source: string }[];
  notes: string[];
  blockers: { source: string; reason: string }[];
  sources: { path: string; blobSha: string; kind: 'manifest' | 'lockfile' | 'workflow'; runtime?: Record<string, string>; packageManager?: string }[];
  ciJobs: { source: string; trigger: unknown; runner: unknown; matrix: unknown;
    runtimes: { program: string; version: unknown; source: string }[];
    steps: { source: string; cwd: unknown; shell: unknown; condition: unknown; continueOnError: unknown }[] }[];
}

function trackedLanguage(files: string[]): string {
  const languages: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
    '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp' };
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.split('/').some(segment => ['node_modules', 'vendor', 'dist', 'build', '.git', '.factory', '.factory-daemon'].includes(segment))) continue;
    const language = languages[path.posix.extname(file)];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked.length && ranked[0]![1] !== ranked[1]?.[1] ? ranked[0]![0] : 'unknown';
}

/** Advisory language only; missing Git evidence never defaults to a preferred stack. */
export async function discoverProjectLanguage(workdir: string): Promise<string> {
  try {
    const files = (await exec('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: workdir, maxBuffer: 8 * 1024 * 1024 })).stdout;
    return trackedLanguage(files.split('\0').filter(Boolean));
  } catch { return 'unknown'; }
}

/** Discover versioned project and CI evidence before editing, never model claims. */
export async function discoverProjectValidation(workdir: string): Promise<ProjectValidationPlan> {
  const git = async (...args: string[]) => (await exec('git', args, { cwd: workdir, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const baselineSha = (await git('rev-parse', 'HEAD')).trim();
  const entries = (await git('ls-tree', '-r', '-z', baselineSha)).split('\0').filter(Boolean)
    .map(line => { const [header, file] = line.split('\t'); return { file: file!, blobSha: header!.split(' ')[2]!, mode: header!.split(' ')[0] }; });
  const files = entries.map(entry => entry.file);
  const plan: ProjectValidationPlan = { baselineSha, primaryLanguage: trackedLanguage(files), checks: [], notes: [], blockers: [], sources: [], ciJobs: [] };
  const manifests = /^(?:package\.json|pyproject\.toml|requirements(?:[-.][\w-]+)?\.txt|Pipfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|composer\.json|Makefile)$|\.(?:csproj|sln)$/;
  const locks = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|packages\.lock\.json|Gemfile\.lock|composer\.lock|gradle\.lockfile)$/;
  for (const entry of entries) {
    if (entry.file.split('/').some(segment => ['node_modules', '.git', '.factory', '.factory-daemon'].includes(segment))) continue;
    const name = path.posix.basename(entry.file);
    const kind = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.file) ? 'workflow'
      : locks.test(name) ? 'lockfile' : manifests.test(name) ? 'manifest' : undefined;
    if (!kind) continue;
    plan.sources.push({ path: entry.file, blobSha: entry.blobSha, kind });
    if (entry.mode === '120000') {
      plan.blockers.push({ source: entry.file, reason: 'validation source is a symlink, not a trusted regular Git blob' });
    } else if (kind === 'workflow') {
      discoverCiValidation(entry.file, await git('show', `${baselineSha}:${entry.file}`), plan);
    }
  }
  for (const file of files) {
    if (path.posix.basename(file) !== 'package.json' || file.split('/').some(segment =>
      ['node_modules', '.git', '.factory', '.factory-daemon'].includes(segment))) continue;
    if (entries.find(entry => entry.file === file)?.mode === '120000') continue;
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
    const source = plan.sources.find(source => source.path === file)!;
    source.runtime = Object.fromEntries(Object.entries(engines ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    source.packageManager = manager || (files.includes(path.posix.join(cwd, 'package-lock.json')) ? 'npm (lockfile)'
      : typeof engines?.npm === 'string' ? 'npm (engines)' : 'unspecified');
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
  for (const source of plan.sources.filter(source => source.kind === 'manifest')) {
    const cwd = path.posix.dirname(source.path);
    if (path.posix.basename(source.path) !== 'package.json' && !plan.ciJobs.length) {
      plan.blockers.push({ source: source.path, reason: 'project declares a non-npm toolchain without a discovered CI validation gate' });
    } else if (path.posix.basename(source.path) === 'package.json'
      && !plan.checks.some(check => check.cwd === cwd) && !plan.ciJobs.length) {
      plan.blockers.push({ source: source.path, reason: 'project manifest has no independently discovered validation gate' });
    }
  }
  if (plan.ciJobs.length) plan.notes.push('CI commands are a local projection only; runner matrices, runtime versions and conditions remain separate CI obligations, not local passes.');
  const unique = new Map<string, ProjectValidationPlan['checks'][number]>();
  for (const check of plan.checks) {
    if (check.program === 'npm' && check.args[0] === 'test') check.args = ['run', 'test', ...check.args.slice(1)];
    const key = JSON.stringify({ program: check.program, args: check.args, cwd: check.cwd });
    const previous = unique.get(key);
    if (previous) previous.source += `; ${check.source}`;
    else unique.set(key, check);
  }
  plan.checks = [...unique.values()];
  return plan;
}
