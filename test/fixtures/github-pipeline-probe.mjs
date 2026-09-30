// Opt-in real GitHub/LLM integration. Never used by the offline test suite.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { fetchIssue } from '../../runtime/github-rest.mjs';

const [workdir, numberText, envFile] = process.argv.slice(2);
const number = Number(numberText);
if (!workdir || !Number.isSafeInteger(number) || number < 1 || !envFile) throw new Error('Usage: probe <dedicated-checkout> <issue-number> <env-file>');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
process.loadEnvFile(envFile);
Object.assign(process.env, {
  GH_TOKEN: token, FACTORY_GH_REPO: '189-sketch/software-factory-demo',
  FACTORY_LOCAL_DIR: '', FACTORY_ISSUE_LEASE_SHA: '', FACTORY_STATE_WRITERS: '',
  FACTORY_STATE_DIR: path.join(path.dirname(workdir), 'r3-runtime'),
  FACTORY_REVIEW_DIR: path.join(path.dirname(workdir), 'r3-review-artifacts'),
  FACTORY_AUTO_MERGE: '0', FACTORY_SYNC_LABELS: '1', FACTORY_SYNC_PROJECTS: '0',
  FACTORY_TRUSTED_EXECUTION: '1', FACTORY_VERIFY_COMMAND: 'node bin/create-scaffold.js --help',
});
const config = resolveFactoryConfig({ cwd: workdir });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { FactoryOrchestrator } = await import('../../dist/factory/orchestrator.js');
const orchestrator = new FactoryOrchestrator({ config,
  skillsRoot: path.join(root, 'dist/factory/skills'),
  repo: { owner: '189-sketch', name: 'software-factory-demo', defaultBranch: 'main', workdir: path.resolve(workdir) },
  remotePath: 'https://github.com/189-sketch/software-factory-demo.git',
});
const issue = await fetchIssue({ repository: config.github.repository, token, number });
const result = await orchestrator.runForIssue(issue);
console.log(JSON.stringify({ issue: number, revision: result.revision, status: result.status, nextLabel: result.nextLabel,
  merged: result.merged, prUrl: result.implementation?.prUrl, wait: result.wait }));
