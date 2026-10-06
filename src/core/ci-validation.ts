import path from 'node:path';
import { parseDocument } from 'yaml';
import { assertSafeAgentCommand } from './tools.js';
import type { ProjectValidationPlan } from './project-validation.js';

type Mapping = Record<string, unknown>;
const mapping = (value: unknown): Mapping => value && typeof value === 'object' && !Array.isArray(value) ? value as Mapping : {};

/** Only literal argv: never approximate shell expansion, chaining or scripts. */
function literalCommand(command: string): { program: string; args: string[] } {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (const character of command.trim()) {
    if (/[\\$`%\r\n]/.test(character) || (!quote && /[|&;<>*?~#!]/.test(character))) {
      throw new Error('shell expansion, escaping or control flow requires CI execution');
    }
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = ''; started = false;
    } else { word += character; started = true; }
  }
  if (quote) throw new Error('unclosed command quote');
  if (started) words.push(word);
  const program = words.shift() ?? '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(program)) throw new Error('program requires a shell or repository executable adapter');
  // CI is evidence, not permission to replay releases or arbitrary infrastructure tools.
  if (!/^(?:node|npm|npx|pnpm|yarn|python[23]?|pytest|ruff|mypy|cargo|go|dotnet|mvn|gradle|make|ctest|cmake|bundle|php|composer)$/.test(program)
    || words.some(word => /^(?:publish|release|deploy|upload|push|login|logout|delete|destroy)(?:$|[:-])/.test(word))) {
    throw new Error('command requires external CI or a purpose-specific capability; it is not authorized for local replay');
  }
  assertSafeAgentCommand(command);
  return { program, args: words };
}

/** Retain complete CI provenance; local projection is not proof of its runner matrix. */
export function discoverCiValidation(file: string, body: string, plan: ProjectValidationPlan): void {
  const block = (source: string, reason: string) => { plan.blockers.push({ source, reason }); };
  let workflow: Mapping;
  try {
    const document = parseDocument(body, { version: '1.2', uniqueKeys: true, stringKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('invalid or unsupported YAML');
    workflow = mapping(document.toJS({ maxAliasCount: 100 }));
    JSON.stringify(workflow); // Reject cyclic YAML aliases before building serializable provenance.
    if (!Object.keys(mapping(workflow.jobs)).length) throw new Error('workflow has no jobs');
  } catch {
    block(file, 'CI workflow cannot be parsed safely; no checks were silently discarded');
    return;
  }
  for (const [jobId, rawJob] of Object.entries(mapping(workflow.jobs))) {
    const job = mapping(rawJob), source = `${file}:jobs.${jobId}`;
    const steps = Array.isArray(job.steps) ? job.steps.map(mapping) : [];
    const defaults = { ...mapping(mapping(workflow.defaults).run), ...mapping(mapping(job.defaults).run) };
    const info: ProjectValidationPlan['ciJobs'][number] = {
      source, trigger: workflow.on ?? null, runner: job['runs-on'] ?? null, matrix: mapping(job.strategy).matrix ?? null,
      runtimes: [], steps: [],
    };
    plan.ciJobs.push(info);
    if (job.uses || !steps.length) block(source, 'reusable or missing CI steps require external CI verification');
    const checkoutElsewhere = steps.some(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')
      && mapping(step.with).path !== undefined && mapping(step.with).path !== '.');
    steps.forEach((step, index) => {
      const stepSource = `${source}.steps[${index}]`;
      if (typeof step.uses === 'string') {
        const setup = /^actions\/setup-(node|python|java|dotnet)@/.exec(step.uses);
        if (setup) {
          info.runtimes.push({ program: setup[1]!, version: mapping(step.with)[`${setup[1]}-version`] ?? null, source: stepSource });
        } else if (!/^actions\/(?:checkout|cache|upload-artifact|download-artifact)@/.test(step.uses)) {
          block(stepSource, 'action-backed check or setup requires external CI verification');
        } else if (/^actions\/download-artifact@/.test(step.uses)) {
          block(stepSource, 'downloaded build input cannot be reproduced by the local validation projection');
        }
        return;
      }
      if (typeof step.run !== 'string') { block(stepSource, 'CI step has no supported command or action'); return; }
      const directory = step['working-directory'] ?? defaults['working-directory'] ?? '.';
      const shell = step.shell ?? defaults.shell;
      info.steps.push({ source: stepSource, cwd: directory, shell: shell ?? null,
        condition: { job: job.if ?? null, step: step.if ?? null },
        continueOnError: { job: job['continue-on-error'] ?? false, step: step['continue-on-error'] ?? false } });
      try {
        if (checkoutElsewhere || job.container || job.services || step.background || step.wait || step['wait-all']) {
          throw new Error('checkout relocation, container, service or asynchronous step requires CI execution');
        }
        if ([workflow.env, job.env, step.env].some(env => Object.keys(mapping(env)).length)) {
          throw new Error('declared CI environment must be reproduced explicitly, not inherited or guessed');
        }
        if (shell !== undefined && (typeof shell !== 'string' || !['bash', 'sh', 'pwsh', 'powershell', 'cmd'].includes(shell))) {
          throw new Error('custom shell requires CI execution');
        }
        if (typeof directory !== 'string' || /[\\$%\r\n\0]/.test(directory) || path.posix.isAbsolute(directory)
          || /^[a-z]:/i.test(directory) || directory.split('/').includes('..')) {
          throw new Error('CI working directory is dynamic or outside the repository');
        }
        const cwd = path.posix.normalize(directory);
        if (cwd.split('/').some(segment => ['.git', '.factory', '.factory-daemon'].includes(segment))) {
          throw new Error('CI working directory references protected metadata');
        }
        const commands = step.run.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        if (!commands.length) throw new Error('empty CI command');
        // Parse the entire step before admitting any line, so cd/export cannot lose context.
        const checks = commands.map(line => ({ ...literalCommand(line), cwd, source: stepSource }));
        plan.checks.push(...checks);
      } catch (error) { block(stepSource, (error as Error).message); }
    });
  }
}
