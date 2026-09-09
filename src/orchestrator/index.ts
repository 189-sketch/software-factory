import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConsoleLogger } from '../core/log.js';
import { SkillLoader } from '../core/skill.js';
import { newRunId } from '../core/agent.js';
import { IssueStore } from '../core/state.js';
import { ALL_FACTORY_LABELS, type AgentContext, type FactoryIssueState, type Issue, type TriageLabel } from '../core/types.js';
import { commitAndPushTool, openPullRequestTool } from '../core/tools.js';
import { TriageAgent } from '../agents/triage.js';
import { SpecAgent } from '../agents/spec.js';
import { ImplementationAgent } from '../agents/implementation.js';
import { ReviewPrAgent } from '../agents/review-pr.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';
import { ImproveReviewPrAgent } from '../agents/improve-review-pr.js';
import { mergePullRequest } from '../github/git.js';

const exec = promisify(execFile);

/** Durable checkpoints own progress; labels expose operator gates, not approval evidence. */
export class FactoryOrchestrator extends EventEmitter {
  private readonly logger = new ConsoleLogger({ orchestrator: 'factory' });
  private readonly loader: SkillLoader;
  private readonly store: IssueStore;
  private readonly repo: AgentContext['repo'];
  private readonly remotePath: string;

  constructor(opts: { skillsRoot: string; repo: AgentContext['repo']; remotePath?: string }) {
    super();
    this.repo = opts.repo;
    this.remotePath = opts.remotePath || '';
    this.loader = new SkillLoader(opts.skillsRoot, opts.repo.workdir);
    this.store = new IssueStore(process.env.FACTORY_STATE_DIR || path.join(opts.repo.workdir, '.factory'));
  }

  private async context(issue: Issue, skill: string, runId = newRunId()): Promise<AgentContext> {
    let body = (await this.loader.load(skill)).body;
    if (skill === 'spec') {
      for (const name of ['write-product-spec', 'write-tech-spec']) body += '\n' + (await this.loader.load(name)).body;
    }
    return { repo: this.repo, issue, skillBody: body, logger: this.logger, runId };
  }

  private async stage<T>(state: FactoryIssueState, name: string, run: () => Promise<T>): Promise<T> {
    state.status = 'running';
    delete state.error;
    state.stages ??= {};
    state.stages[name] = { startedAt: new Date().toISOString(), status: 'running' };
    await this.store.save(state);
    this.logger.info(`issue #${state.issue.number} stage=${name} started`);
    try {
      const result = await run();
      state.stages[name].status = 'completed';
      this.emit(name, { issueNumber: state.issue.number, result });
      return result;
    } catch (error) {
      state.stages[name].status = 'failed';
      throw error;
    } finally {
      state.stages[name].endedAt = new Date().toISOString();
      await this.store.save(state);
    }
  }

  private async transition(state: FactoryIssueState, label: TriageLabel, status: FactoryIssueState['status'] = 'running') {
    state.nextLabel = label;
    state.status = status;
    state.labelPending = true;
    await this.store.save(state);
    await syncLabel(state.issue, label);
    state.labelPending = false;
    await this.store.save(state);
  }

  async runTriage(issue: Issue): Promise<FactoryIssueState> {
    const state: FactoryIssueState = { issue, merged: false, agentMode: 'llm' };
    state.triage = await this.stage(state, 'triage', async () => new TriageAgent(await this.context(issue, 'triage')).run());
    await publishTriageDecision(issue, state.triage.comment);
    await this.transition(state, state.triage.label, 'waiting');
    return state;
  }

  async runForIssue(issue: Issue): Promise<FactoryIssueState> {
    const state = await this.store.load(issue.number) ?? { issue, merged: false, attempts: 0, agentMode: 'llm' as const };
    const changed = JSON.stringify([state.issue.title, state.issue.body, state.issue.comments]) !== JSON.stringify([issue.title, issue.body, issue.comments]);
    state.issue = issue;
    state.agentMode = 'llm';
    if (state.merged) { await syncLabel(issue, null); return state; }
    if (state.status === 'failed') throw new Error(`Task requires operator intervention: ${state.error}`);
    if (state.status === 'simulated') return state;
    const external = issue.labels.filter((label) => ALL_FACTORY_LABELS.includes(label));
    if (external.length > 1) {
      // Pick the highest-priority label by `ALL_FACTORY_LABELS` order and
      // auto-clear the rest via `syncLabel` on the next transition. This
      // self-heals a common operator mistake (e.g. toggling between
      // ready-to-implement and ready-to-spec) without forcing a manual
      // cleanup. The state-machine order in ALL_FACTORY_LABELS determines
      // which label wins.
      const winner = ALL_FACTORY_LABELS.find((label) => external.includes(label));
      if (winner) issue.labels = [...external.filter((label) => label !== winner), winner];
    }
    let forceRetriage = false;
    if (state.labelPending && state.nextLabel) await this.transition(state, state.nextLabel, state.status);
    else if (state.status === 'waiting' && external[0] && external[0] !== state.nextLabel) state.nextLabel = external[0];
    else if (state.status === 'waiting' && ['needs-info', 'wait-to-implement'].includes(state.nextLabel ?? '') &&
      (changed || external[0] !== state.nextLabel)) {
      delete state.nextLabel;
      delete state.triage;
      forceRetriage = true;
    }
    else if (state.status === 'waiting' && state.nextLabel === 'verify-failed' && state.implementation?.behaviorVerification?.status === 'blocked') return state;
    let label = forceRetriage ? null : state.nextLabel ?? external[0] ?? null;
    const runId = newRunId();
    const context = (name: string) => this.context(issue, name, runId);
    try {
      if (state.implementation) {
        await exec('git', ['fetch', 'origin', state.implementation.branch, this.repo.defaultBranch], { cwd: this.repo.workdir });
        const current = (await exec('git', ['branch', '--show-current'], { cwd: this.repo.workdir })).stdout.trim();
        if (current !== state.implementation.branch) await exec('git', ['checkout', '--track', `origin/${state.implementation.branch}`], { cwd: this.repo.workdir });
        // Accept either an exact match (HEAD == recorded commit) OR a
        // recorded commit that is an ancestor of HEAD (operator rebased or
        // squashed extra commits on top). A strict `head !== commitSha`
        // check rejected legitimate "added fixes on top" flows.
        const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: this.repo.workdir })).stdout.trim();
        const recorded = state.implementation.commitSha;
        if (head !== recorded) {
          try {
            await exec('git', ['merge-base', '--is-ancestor', recorded, 'HEAD'], { cwd: this.repo.workdir });
          } catch {
            throw new Error('Implementation checkpoint is not the current HEAD and not an ancestor of HEAD; reconcile before resuming');
          }
        }
      }
      for (;;) {
        if (!label) {
          state.triage = await this.stage(state, 'triage', async () => new TriageAgent(await context('triage')).run());
          await publishTriageDecision(issue, state.triage.comment);
          label = state.triage.label;
          await this.transition(state, label, ['needs-info', 'wait-to-implement'].includes(label) ? 'waiting' : 'running');
          continue;
        }
        if (label === 'ready-to-spec') {
          state.specs = await this.stage(state, 'spec', async () => new SpecAgent(await context('spec')).run());
          const ctx = await context('spec');
          const spec = state.specs;
          const files = [`specs/${spec.product.slug}/PRODUCT.md`, `specs/${spec.tech.slug}/TECH.md`];
          const commit = await commitAndPushTool(ctx).execute({ branch: spec.specBranch, message: `Specify issue #${issue.number}`, files }, ctx) as { ok: boolean; commitSha: string };
          if (!commit.ok) throw new Error('Specification publication failed');
          const pr = await openPullRequestTool(ctx, this.remotePath).execute({ branch: spec.specBranch, title: `Spec: ${issue.title}`, body: `Specifications for #${issue.number}. Review and merge before setting ready-to-implement.`, baseBranch: this.repo.defaultBranch }, ctx) as { prUrl: string; headSha: string };
          if (!pr.prUrl || pr.headSha !== commit.commitSha) throw new Error('Specification PR not confirmed');
          spec.specPrUrl = pr.prUrl;
          await this.transition(state, 'spec-ready-for-review', 'waiting');
          return state;
        }
        if (['ready-to-implement', 'changes-requested', 'verify-failed'].includes(label)) {
          if ((state.attempts ?? 0) >= 3) throw new Error('Implementation attempt limit reached (3)');
          if (state.specs) {
            // Approved specifications must exist on the base checkout, not just in a lost temporary clone.
            for (const [slug, name] of [[state.specs.product.slug, 'PRODUCT.md'], [state.specs.tech.slug, 'TECH.md']]) {
              await exec('git', ['cat-file', '-e', `origin/${this.repo.defaultBranch}:specs/${slug}/${name}`], { cwd: this.repo.workdir });
            }
          }
          const ctx = await context('implementation');
          ctx.skillBody += '\n\nPrior attempt feedback:\n' + buildImplementationFeedback(state);
          state.attempts = (state.attempts ?? 0) + 1;
          state.implementation = await this.stage(state, 'implementation', () => new ImplementationAgent(ctx, this.remotePath).run());
          delete state.review;
          delete state.reviewedSha;
          delete state.verifiedSha;
          delete state.implementation.behaviorVerification;
          label = 'review-needed';
          await this.transition(state, label);
          continue;
        }
        if (['review-needed', 'ready-to-merge', 'verified'].includes(label)) {
          if (!state.implementation) throw new Error('Missing implementation checkpoint; cannot resume review or merge');
          const implementation = state.implementation;
          const sha = implementation.commitSha;
          const baseSha = (await exec('git', ['rev-parse', `origin/${this.repo.defaultBranch}`], { cwd: this.repo.workdir })).stdout.trim();
          if (!state.review || state.reviewedSha !== sha || state.reviewedBaseSha !== baseSha) {
            await this.prepareReviewArtifacts(state);
            state.review = await this.stage(state, 'review', async () => new ReviewPrAgent(await context('review-pr')).run());
            state.reviewedSha = sha;
            state.reviewedBaseSha = baseSha;
            delete implementation.behaviorVerification;
            delete state.verifiedSha;
            label = state.review.verdict === 'APPROVE' ? 'ready-to-merge' : 'changes-requested';
            await this.transition(state, label);
            continue;
          }
          if (state.review.verdict !== 'APPROVE') {
            label = 'changes-requested';
            await this.transition(state, label);
            continue;
          }
          if (!implementation.behaviorVerification || state.verifiedSha !== sha) {
            await this.assertVerificationCheckout(sha);
            implementation.behaviorVerification = await this.stage(state, 'verify', async () => new VerifyBehaviorAgent(await context('verify-behavior')).run());
            await this.assertVerificationCheckout(sha);
            const verified = implementation.behaviorVerification.status === 'verified';
            state.stages!.verify.status = verified ? 'completed' : 'failed';
            await this.store.save(state);
            if (verified) state.verifiedSha = sha;
            label = verified ? 'verified' : 'verify-failed';
            const blocked = implementation.behaviorVerification.status === 'blocked';
            await this.transition(state, label, blocked ? 'waiting' : 'running');
            if (blocked) return state;
            continue;
          }
          if (implementation.behaviorVerification.status !== 'verified') {
            label = 'verify-failed';
            await this.transition(state, label);
            continue;
          }
          if (process.env.FACTORY_AUTO_MERGE !== '1') { await this.transition(state, 'verified', 'waiting'); return state; }
          await this.stage(state, 'merge', async () => mergePullRequest({ workdir: this.repo.workdir, remotePath: this.remotePath, prUrl: implementation.prUrl, expectedHeadSha: sha }));
          state.merged = true;
          state.status = 'completed';
          await this.store.save(state);
          await syncLabel(issue, null);
          this.emit('merged', { issueNumber: issue.number });
          return state;
        }
        state.status = 'waiting';
        await this.store.save(state);
        return state;
      }
    } catch (error) {
      state.status = (state.attempts ?? 0) >= 3 ? 'failed' : 'waiting';
      state.error = String(error);
      await this.store.save(state);
      throw error;
    }
  }

  private async prepareReviewArtifacts(state: FactoryIssueState) {
    const patch = (await exec('git', ['diff', '--unified=3', `origin/${this.repo.defaultBranch}...${state.implementation!.commitSha}`], { cwd: this.repo.workdir, maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (!patch.trim()) throw new Error('Review diff is empty');
    await fs.writeFile(path.join(this.repo.workdir, 'pr_diff.txt'), annotateDiff(patch));
    await fs.writeFile(path.join(this.repo.workdir, 'pr_description.txt'), state.implementation!.comment);
  }

  private async assertVerificationCheckout(expectedSha: string): Promise<void> {
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: this.repo.workdir })).stdout.trim();
    if (head !== expectedSha) throw new Error('Behavior verification checkout no longer matches the reviewed implementation commit');
    try {
      await exec('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: this.repo.workdir });
      await exec('git', ['diff', '--cached', '--quiet', '--'], { cwd: this.repo.workdir });
    } catch {
      throw new Error('Behavior verification modified tracked implementation files; evidence is not valid for the reviewed commit');
    }
  }

  async runVerifyBehavior(issue: Issue, mode: 'reproduce' | 'verify' = 'verify') {
    return new VerifyBehaviorAgent(await this.context(issue, 'verify-behavior'), mode).run();
  }

  async runReviewPr(issue: Issue) {
    const diff = await fs.readFile(path.join(this.repo.workdir, 'pr_diff.txt'), 'utf8');
    if (!diff.trim()) throw new Error('Review stage requires a non-empty annotated pr_diff.txt');
    return new ReviewPrAgent(await this.context(issue, 'review-pr')).run();
  }

  async runImproveReviewPr(issue: Issue) {
    return new ImproveReviewPrAgent(await this.context(issue, 'improve-review-pr'), this.remotePath, (await this.loader.load('review-pr')).body).run();
  }

  async triggerByLabel(issue: Issue, label: TriageLabel) {
    return this.runForIssue({ ...issue, labels: [label] });
  }

  /** Checkpoints are persisted at each transition, not only on successful CLI exit. */
  async persist(): Promise<void> {}
}

async function syncLabel(issue: Issue, label: TriageLabel | null) {
  if (process.env.FACTORY_SYNC_LABELS === '0') return;
  const repo = process.env.FACTORY_GH_REPO;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) return;
  const env = { ...process.env, GH_TOKEN: token };
  const current = JSON.parse((await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'labels'], { env })).stdout).labels.map((item: { name: string }) => item.name);
  if (label) await exec('gh', ['label', 'create', label, '--repo', repo, '--color', '5319E7', '--force'], { env });
  const args = ['issue', 'edit', String(issue.number), '--repo', repo];
  for (const old of current) if (ALL_FACTORY_LABELS.includes(old) && old !== label) args.push('--remove-label', old);
  if (label && !current.includes(label)) args.push('--add-label', label);
  if (args.length > 5) await exec('gh', args, { env });
}

async function publishTriageDecision(issue: Issue, comment: string) {
  if (process.env.FACTORY_SYNC_LABELS === '0') return;
  const repo = process.env.FACTORY_GH_REPO;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) return;
  const marker = `<!-- pi-software-factory:triage:${issue.number}:${createHash('sha256').update(comment).digest('hex').slice(0, 16)} -->`;
  const env = { ...process.env, GH_TOKEN: token };
  const current = JSON.parse((await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments'], { env })).stdout) as { comments?: Array<{ body?: string }> };
  if (current.comments?.some((entry) => entry.body?.includes(marker))) return;
  await exec('gh', ['issue', 'comment', String(issue.number), '--repo', repo, '--body', `${comment}\n\n${marker}`], { env });
}

function buildImplementationFeedback(state: FactoryIssueState): string {
    const lines: string[] = [];
    if (state.review && state.review.verdict === "REJECT") {
        lines.push(
            `Review REJECTED the previous attempt. Body:`,
            state.review.body || "(no body)",
        );
        for (const c of state.review.comments ?? []) {
            lines.push(`- ${c.path}:${c.line}  ${c.body}`);
        }
        lines.push(
            ``,
            `Address every review comment before opening a new PR. Do NOT just re-submit — the diff must be materially different.`,
        );
    }
    if (state.implementation?.behaviorVerification) {
        const v = state.implementation.behaviorVerification;
        lines.push(
            ``,
            `Verify-behavior ran with status=${v.status}; channel=${v.channel}. Notes: ${v.notes || "(none)"}`,
        );
        if (v.ozRunUrl) lines.push(`oz run: ${v.ozRunUrl}`);
        for (const ev of v.evidence ?? []) {
            lines.push(`- [${ev.kind}] ${ev.caption} → ${ev.path}`);
        }
        if (v.status !== "verified") {
            lines.push(
                `The verify step did not pass. Read the notes and the evidence; fix the underlying issue, not the symptoms.`,
            );
        }
    }
    if (lines.length === 0) return "Fresh implementation pass; no prior feedback.";
    return lines.join("\n");
}


function annotateDiff(patch: string): string {
    const output: string[] = [];
    let oldLine: number | null = null;
    let newLine: number | null = null;
    for (const raw of patch.split("\n")) {
        const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            output.push(raw);
        } else if (raw.startsWith("--- ") || raw.startsWith("+++ ") || oldLine === null || newLine === null) {
            output.push(raw);
        } else if (raw.startsWith("-")) {
            output.push(`[OLD:${oldLine}] ${raw.slice(1)}`);
            oldLine += 1;
        } else if (raw.startsWith("+")) {
            output.push(`[NEW:${newLine}] ${raw.slice(1)}`);
            newLine += 1;
        } else if (raw.startsWith(" ")) {
            output.push(`[OLD:${oldLine},NEW:${newLine}] ${raw.slice(1)}`);
            oldLine += 1;
            newLine += 1;
        } else {
            output.push(raw);
        }
    }
    return output.join("\n");
}
