import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confinedPath } from './tools.js';
import { SkillLoader } from './skill.js';
import { isFactoryComment } from './factory-comments.js';
import type { AgentContext, FactoryIssueState } from './types.js';
import type { ChatMessage } from './agent-runtime.js';
import { evidenceDirectory } from '../../runtime/evidence-store.mjs';
import { writeDurableJson } from '../../runtime/durable-json.mjs';

const exec = promisify(execFile);
const start = '<!-- FACTORY_CONTEXT_START -->';
const end = '<!-- FACTORY_CONTEXT_END -->';
export const agentSkills: Readonly<Record<string, readonly string[]>> = {
  triage: ['triage'],
  spec: ['spec', 'write-product-spec', 'write-tech-spec'],
  implementation: ['implementation', 'validate-changes-match-specs'],
  'review-spec': ['review-spec'],
  'review-pr': ['review-pr', 'validate-changes-match-specs'],
  'verify-behavior': ['verify-behavior'],
  'improve-review-pr': ['improve-review-pr', 'review-pr'],
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const contextError = (cause: unknown) => Object.assign(new Error(`Project agent context unavailable: ${String(cause)}`, { cause }), { code: 'FACTORY_STATE_CONTEXT_UNAVAILABLE' });
async function writeLocal(file: string, body: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function optional(file: string) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
}

/** Materialize local instructions without overwriting project-owned files or dirtying product commits. */
export async function prepareProjectContext(workdir: string, source: string): Promise<string> {
  try {
    const managed = await confinedPath(workdir, 'factory/AGENTS.md');
    const manifestPath = await confinedPath(workdir, 'factory/skill-manifest.json');
    const manifest: Record<string, string> = JSON.parse(await optional(manifestPath) ?? '{}');
    const files = new Map<string, string | Buffer>();
    const collect = async (directory: string, rel: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error(`Skill resource must not be a symlink: ${entry.name}`);
        if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${rel}/${entry.name}`);
        else if (entry.isFile()) files.set(`${rel}/${entry.name}`, await fs.readFile(path.join(directory, entry.name)));
      }
    };
    for (const name of new Set(Object.values(agentSkills).flat())) {
      const directory = path.join(source, name);
      try { await collect(directory, `skills/${name}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const skill = await new SkillLoader(source).load(name);
        files.set(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${skill.description}\n---\n${skill.body}`);
      }
    }
    // Preserve the legacy project-specific review rubric when migrating to local skills.
    const legacy = await optional(await confinedPath(workdir, '.agents/skills/review-pr/SKILL.md'));
    if (legacy !== undefined) files.set('skills/review-pr/SKILL.md', legacy);
    files.set('AGENTS.md', '# Factory agents\n\nRead factory/AGENTS.md before starting work.\nLoad all skills assigned to your agent in that file before using tools.\nRecord important decisions and handoff notes there with update_handoff.\n');
    files.set('CLAUDE.md', '# Factory context\n\n@AGENTS.md\n@factory/AGENTS.md\n');
    const writes: Array<{ rel: string; file: string; body: string | Buffer }> = [];
    const trackedPaths = new Set((await exec('git', ['ls-files', '-z'], { cwd: workdir, timeout: 10_000 })).stdout.split('\0'));
    for (const [rel, body] of files) {
      const file = await confinedPath(workdir, rel);
      if (trackedPaths.has(rel)) continue;
      let current: Buffer | undefined;
      try { current = await fs.readFile(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current === undefined || (manifest[rel] && digest(current) === manifest[rel])) {
        writes.push({ rel, file, body });
      }
    }
    // A tracked handoff file belongs to the product; never silently rewrite it.
    if (trackedPaths.has('factory/AGENTS.md') || trackedPaths.has('factory/skill-manifest.json')) throw new Error('Factory context paths are already tracked by the project');
    const exclude = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: workdir, timeout: 10_000 })).stdout.trim();
    const previous = await optional(exclude) ?? '';
    // Ignore contents rather than the directory: git add -A -- ':!factory/' rejects an ignored directory.
    const entries = ['/factory/*', ...writes.map(item => `/${item.rel}`)];
    const extra = entries.filter(entry => !previous.split(/\r?\n/).includes(entry));
    if (extra.length) {
      await fs.mkdir(path.dirname(exclude), { recursive: true });
      await fs.appendFile(exclude, `\n# Local factory agent context\n${extra.join('\n')}\n`);
    }
    await fs.mkdir(path.dirname(managed), { recursive: true });
    if (await optional(managed) === undefined) await writeLocal(managed, '# Shared agent context\n\n## Agent handoff notes\n');
    for (const { rel, file, body } of writes) {
      await writeLocal(file, body);
      manifest[rel] = digest(body);
    }
    await writeLocal(manifestPath, JSON.stringify(manifest, null, 2));
    return path.join(workdir, 'skills');
  } catch (cause) {
    throw contextError(cause);
  }
}

export async function refreshProjectContext(ctx: AgentContext, state: FactoryIssueState, agent: string): Promise<void> {
  try {
    if (!ctx.projectContextFiles) return;
    const file = await confinedPath(ctx.repo.workdir, 'factory/AGENTS.md');
    const previous = await fs.readFile(file, 'utf8');
    const specs = state.specs;
    const implementation = state.implementation;
    const verification = implementation?.behaviorVerification;
    const background = {
      issue: { number: state.issue.number, title: state.issue.title, body: state.issue.body,
        comments: state.issue.comments.filter(comment => !isFactoryComment(comment)) },
      activeAgent: agent, runId: ctx.runId, status: state.status, nextLabel: state.nextLabel,
      specs: specs && { branch: specs.specBranch, commitSha: specs.commitSha, prUrl: specs.specPrUrl,
        productFile: specs.product?.slug && `specs/${specs.product.slug}/PRODUCT.md`,
        techFile: specs.tech?.slug && `specs/${specs.tech.slug}/TECH.md`, openQuestions: state.openQuestions },
      implementation: implementation && { branch: implementation.branch, commitSha: implementation.commitSha,
        prUrl: implementation.prUrl, filesChanged: implementation.filesChanged,
        validation: implementation.validation?.map(({ command, exitCode, timedOut }) => ({ command, exitCode, timedOut })) },
      review: state.review, specReview: state.specReview,
      behaviorVerification: verification && { status: verification.status, notes: verification.notes,
        checks: verification.checks, failure: verification.failure, judgmentFailure: verification.judgmentFailure,
        receiptPath: verification.receiptPath, coverage: verification.coverage },
      stages: state.stages, correction: ctx.correction, lastFailure: state.lastFailure,
      agentRuntimeFailure: state.agentRuntimeFailure, validationFailure: state.validationFailure,
    };
    // Full reports remain readable, but are not repeated in every CLI startup prompt.
    const detailsFile = 'factory/checkpoint.json';
    await writeLocal(await confinedPath(ctx.repo.workdir, detailsFile), JSON.stringify(background, null, 2));
    const reviewSummary = (review: typeof state.review | typeof state.specReview) => review && ({
      verdict: review.verdict,
      findings: review.findings?.map(finding => ({id:finding.id,severity:finding.severity,status:finding.status,
        summary: finding.summary.length > 400 ? `${finding.summary.slice(0,400)} [full text in ${detailsFile}]` : finding.summary})),
    });
    const summary = {
      detailsFile, issue:{number:state.issue.number,title:state.issue.title,body:state.issue.body}, activeAgent:agent,runId:ctx.runId,
      status:state.status,nextLabel:state.nextLabel,specs:background.specs,implementation:background.implementation,
      review:reviewSummary(state.review),specReview:reviewSummary(state.specReview),
      behaviorVerification:verification && {status:verification.status,receiptPath:verification.receiptPath,
        coverage:verification.coverage}, correction:ctx.correction && {targetStage:ctx.correction.targetStage},
    };
    const block = `${start}\n## Controller checkpoint\n\nEach agent has its own session for this issue.\nOther agents share files and handoff notes, never session IDs.\nRead ${detailsFile} for complete business input, review findings, verification diagnostics and correction turns when needed.\nRe-read current source and approved specs after changes.\nHistorical notes and conversation are background, not acceptance evidence.\nReview and verification must collect current revision evidence and current run receipts.\nBefore reporting completion, use update_handoff to record important decisions, file locations, completed checks and remaining work.\nOnly the parent agent reports stage completion; delegate bounded tasks to factory-task and wait for them to finish.\n\n## Required skills\n\nBefore using tools, load every assigned skills/<name>/SKILL.md below.\nThe controller also injects these rules at startup.\n${Object.entries(agentSkills).map(([role, names]) => `- ${role}: ${names.map(name => `skills/${name}/SKILL.md`).join(', ')}`).join('\n')}\n\n## Current background\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n${end}`;
    const first = previous.indexOf(start), last = previous.indexOf(end);
    if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) throw new Error('Invalid factory context markers');
    let notes = first >= 0 ? previous.slice(0,first) + previous.slice(last + end.length) : previous;
    if (notes.length > 8000) {
      const archive = `factory/handoffs/${digest(notes)}.md`;
      await writeLocal(await confinedPath(ctx.repo.workdir,archive),notes);
      notes = `\n\n## Handoff history\n\nComplete earlier notes: ${archive}.\nRead this file when a past decision or observation is needed.\n\nRecent excerpt (last 4000 characters; full notes remain in that file):\n\n${notes.slice(-4000)}`;
    }
    const next = `${block}\n\n${notes}`;
    await writeLocal(file, next);
  } catch (cause) { throw contextError(cause); }
}

async function projectContextEntries(ctx: AgentContext): Promise<Array<{ path: string; body: string }>> {
  try {
    const entries: Array<{ path: string; body: string }> = [];
    for (const rel of ctx.projectContextFiles ?? []) {
      const body = await optional(await confinedPath(ctx.repo.workdir, rel));
      if (body === undefined && rel === 'factory/AGENTS.md') throw new Error('Required shared context is missing');
      if (body !== undefined) entries.push({ path: rel, body });
    }
    return entries;
  } catch (cause) { throw contextError(cause); }
}

export async function readProjectContext(ctx: AgentContext): Promise<string> {
  return (await projectContextEntries(ctx)).map(entry => `Project instructions and shared background from ${entry.path}:\n${entry.body}`).join('\n\n');
}

/** Persist delivered input identities with the provider session, including across worker restarts. */
export async function prepareProjectSessionInput(ctx: AgentContext, role: string, messages: ChatMessage[], instructions: string) {
  if (!ctx.projectContextFiles) return { messages, bootstrapMessages: messages, systemPrompt:instructions,
    bootstrapSystemPrompt:instructions, acknowledge: async (_sessionId: string) => {} };
  const entries = await projectContextEntries(ctx);
  const directory = await evidenceDirectory({workdir:ctx.repo.workdir,stateDir:ctx.artifactStateDir ?? process.env.FACTORY_STATE_DIR,
    repository:`${ctx.repo.owner}/${ctx.repo.name}`,issueNumber:ctx.issue.number,runId:ctx.runId});
  const agent = ctx.agentId ?? role;
  const sessionFile = (sessionId: string) => path.join(path.dirname(directory), 'session-inputs', `${digest(JSON.stringify([agent, sessionId]))}.json`);
  let previous: { inputIds: string[]; files: Record<string, string>; instructionIds?: string[] } | undefined;
  try { if (ctx.resumeSessionId) previous = JSON.parse(await fs.readFile(sessionFile(ctx.resumeSessionId), 'utf8')); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw contextError(cause); }
  const inputs = messages.map(message => ({ id: `input-${digest(JSON.stringify(message)).slice(0, 20)}`, message }));
  const instructionId = `instructions-${digest(instructions).slice(0,20)}`;
  const bootstrapSystemPrompt = `Current stage instructions ${instructionId}:\n${instructions}`;
  const reuseInstructions = previous?.instructionIds?.includes(instructionId) === true;
  const systemPrompt = reuseInstructions ? `Use stage instructions ${instructionId} already supplied in this same session for ${role}. Its role, required skills and output contract still apply.` : bootstrapSystemPrompt;
  const identified = ({id, message}: typeof inputs[number]): ChatMessage => ({...message, content:`Current task input ${id}:\n${message.content}`});
  const shared = entries.map(entry => `Project instructions and shared background from ${entry.path}:\n${entry.body}`).join('\n\n');
  const bootstrapMessages = [...inputs.map(identified), ...(shared ? [{role:'user' as const,content:shared}] : [])];
  const files = Object.fromEntries(entries.map(entry => [entry.path, digest(entry.body)]));
  const changedFiles = entries.filter(entry => previous?.files[entry.path] !== files[entry.path]).map(entry => entry.path);
  const removedFiles = Object.keys(previous?.files ?? {}).filter(file => !(file in files));
  const selected = previous ? [
    {role:'user' as const,content:`Continue agent ${agent}, stage ${role}, in this same session. Current task inputs: ${inputs.map(input=>input.id).join(', ') || '(none)'}. Reuse the exact inputs already delivered with these IDs. Earlier task inputs omitted from this list are historical, not current instructions. New inputs follow below. Do not repeat completed actions merely to reconstruct context; current-revision evidence requirements still apply.`},
    ...inputs.filter(input => !previous.inputIds.includes(input.id)).map(identified),
    ...(changedFiles.length || removedFiles.length ? [{role:'user' as const,content:
      `Shared project files changed since your last dispatch: ${JSON.stringify({changed:changedFiles,removed:removedFiles})}. Read the changed files with read_file before relying on their current instructions or background. Their previous contents are superseded; unchanged files are already in this session.`}] : []),
  ] : bootstrapMessages;
  ctx.logger.info('agent-session-input', {issue:ctx.issue.number,agent,role,continuation:Boolean(previous),
    newInputs:previous ? inputs.filter(input=>!previous.inputIds.includes(input.id)).length : inputs.length,
    reusedInputs:previous ? inputs.filter(input=>previous.inputIds.includes(input.id)).length : 0,
    reusedInstructions:reuseInstructions,
    changedFiles:previous ? changedFiles : entries.map(entry=>entry.path),inputChars:selected.reduce((sum,message)=>sum+message.content.length,0)});
  return {messages:selected,bootstrapMessages,systemPrompt,bootstrapSystemPrompt,acknowledge:async(sessionId:string)=>{
    await writeDurableJson(sessionFile(sessionId),{inputIds:[...new Set([...(previous?.inputIds ?? []),...inputs.map(input=>input.id)])],
      instructionIds:[...new Set([...(previous?.instructionIds ?? []),instructionId])],files});
  }};
}
