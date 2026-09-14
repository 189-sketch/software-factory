import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConsoleLogger } from '../core/log.js';
import { SkillLoader } from '../core/skill.js';
import { newRunId } from '../core/agent-runtime.js';
import { IssueStore } from '../core/state.js';
import { ALL_FACTORY_LABELS, FACTORY_LABELS_TO_CLEAR, RETIRED_FACTORY_LABELS, type AgentContext, type AgentEvent, type FactoryIssueState, type Issue, type PipelineFailure, type PriorAttempt, type TriageLabel, type TriageRouting } from '../core/types.js';
import { commitAndPushTool, openPullRequestTool } from '../core/tools.js';
import { TriageAgent } from '../agents/triage.js';
import { SpecAgent, specBodiesChanged } from '../agents/spec.js';
import { ReviewSpecAgent } from '../agents/review-spec.js';
import { ImplementationAgent } from '../agents/implementation.js';
import { ReviewPrAgent } from '../agents/review-pr.js';
import { VerifyBehaviorAgent, consumeReceiptRegistry } from '../agents/verify-behavior.js';
import { ImproveReviewPrAgent } from '../agents/improve-review-pr.js';
import { mergePullRequest } from '../github/git.js';
import { projectStatusForLabel, projectStatusForStage, syncIssueProjectStatus, type ProjectStatus } from '../github/project.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import type { FactoryConfig } from '../../runtime/factory-config.mjs';
import {
  COMPLETED_PROJECT_STATUS,
  labelForStage as pipelineLabelForStage,
  normalizeStageId,
  stageForLabel,
} from '../../runtime/pipeline-definition.mjs';

const exec = promisify(execFile);

/**
 * Implementation Acceptance Contract.
 *
 * An implementation run is only valid when ALL of these hold:
 *   1. The worktree is clean (no uncommitted, untracked, or staged
 *      changes). Untracked files like `*.tmp-test/probe.js` previously
 *      slipped past the contract and caused "Target checkout is not
 *      clean" downstream.
 *   2. A branch matching `feature/issue-<n>-*` is checked out.
 *   3. The recorded commitSha exists on origin (the agent actually
 *      pushed, not just committed locally).
 *   4. The branch points at the recorded commitSha (no rebase drift
 *      between local and remote).
 *
 * Failing this gate throws a concrete error that the retry loop can
 * surface to triage-supervisor. The supervisor then knows it is a
 * "implementation did not finalize" symptom, not a "spec content is
 * wrong" symptom, and routes to a retry of the implementation stage
 * rather than escalating to needs-info.
 */
export async function assertImplementationContract(
    implementation: { commitSha?: string; branch?: string } | undefined,
    repo: AgentContext['repo'],
    issueNumber: number,
    _config: FactoryConfig,
): Promise<void> {
    if (!implementation?.commitSha) {
        throw new Error('Implementation did not return a commitSha — agent must commit and push before exiting');
    }
    if (!implementation.branch) {
        throw new Error('Implementation did not return a branch — agent must push to a feature/issue-* branch');
    }
    if (!implementation.branch.startsWith(`feature/issue-${issueNumber}-`)) {
        throw new Error(`Implementation branch "${implementation.branch}" does not match feature/issue-${issueNumber}-* convention`);
    }
    // 1. Worktree is clean.
    const status = (await exec('git', ['status', '--porcelain'], { cwd: repo.workdir })).stdout;
    if (status.trim()) {
        throw new Error(
            `Implementation finished with a dirty working tree. The agent must commit + push its work before returning. ` +
            `Uncommitted files:\n${status.split('\n').slice(0, 10).join('\n')}`,
        );
    }
    // 2. Branch is checked out.
    const current = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.workdir })).stdout.trim();
    if (current !== implementation.branch) {
        throw new Error(`Implementation agent left the worktree on "${current}" but should be on "${implementation.branch}"`);
    }
    // 3. Recorded commitSha exists on origin. We use plain `rev-parse`
    // (not `--verify -- <ref>`) because `--verify -- <remote>/<branch>`
    // is brittle in linked worktrees: when the upstream is set the ref
    // resolves correctly, but in test setups and freshly added worktrees
    // `--verify --` rejects the ref with "Needed a single revision"
    // even though plain `rev-parse` resolves it. Plain `rev-parse` is
    // idempotent for any ref that exists, so this is the safer check.
    try {
        await exec('git', ['rev-parse', `origin/${implementation.branch}`], { cwd: repo.workdir });
    } catch {
        throw new Error(`Implementation branch "${implementation.branch}" was never pushed to origin`);
    }
    // 4. The branch on origin points at the recorded commit.
    const originHead = (await exec('git', ['rev-parse', `origin/${implementation.branch}`], { cwd: repo.workdir })).stdout.trim();
    if (originHead !== implementation.commitSha) {
        throw new Error(
            `Implementation commitSha drift: agent recorded ${implementation.commitSha} but ` +
            `origin/${implementation.branch} points at ${originHead}. The agent must ensure the recorded ` +
            `commitSha is the same one pushed.`,
        );
    }
}
const SPEC_LOOP_VERSION = 2;

/**
 * Mechanical loop breaker for the triage supervisor.
 *
 * Pure count of how many times the supervisor has judged a failure for
 * this issue. Triage decides WHAT to do about each failure (retry,
 * reroute, needs-info, abort); this cap bounds HOW MANY times it may
 * decide before an operator is required. Configurable via
 * `FACTORY_MAX_AGENT_FAILURES` (positive integer; default 50).
 *
 * Replaces three older counters that all measured "how stuck is this
 * issue" in different ways: `MAX_IMPL_ATTEMPTS`, `MAX_PARSE_FAILURE_HEALS`,
 * and the `specAttempts >= 3` ceiling. Unifying them means the same
 * knob governs every stage, and "is this issue stuck?" is a question
 * one counter answers instead of three.
 */
export const MAX_AGENT_FAILURES = resolveMaxAgentFailures(process.env.FACTORY_MAX_AGENT_FAILURES);

/**
 * Parse `FACTORY_MAX_AGENT_FAILURES`. Pure function so the validation
 * rules can be unit-tested without touching `process.env`.
 *
 * Accepts only positive integers. `0` is rejected so a typo doesn't
 * silently disable the cap and let an issue spin forever.
 */
export function resolveMaxAgentFailures(raw: string | undefined): number {
  const fallback = 50;
  if (raw === undefined || raw === '') return fallback;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid FACTORY_MAX_AGENT_FAILURES: ${JSON.stringify(raw)} (must be a positive integer)`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid FACTORY_MAX_AGENT_FAILURES: ${JSON.stringify(raw)} (must be a positive integer)`);
  }
  return value;
}

/**
 * Byte budget for the diff snapshot attached to `PriorAttempt`. We
 * truncate rather than omit because the LLM needs the diff to make a
 * materially different attempt — but unbounded diffs blow the prompt.
 */
const PRIOR_DIFF_MAX_BYTES = 64 * 1024;

/**
 * Parse the maximum-implementation-attempts env var. Pure function so
 * the validation rules can be unit-tested without touching
 * `process.env` module state.
 */
export function resolveMaxImplAttempts(raw: string | undefined): number {
  const fallback = 10;
  if (raw === undefined || raw === '') return fallback;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid FACTORY_MAX_IMPL_ATTEMPTS: ${JSON.stringify(raw)} (must be a positive integer)`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid FACTORY_MAX_IMPL_ATTEMPTS: ${JSON.stringify(raw)} (must be a positive integer)`);
  }
  return value;
}

/**
 * Build the typed `PriorAttempt` artifact from the durable state. Called
 * before each implementation retry so the ImplementationAgent has
 * structured access to what it (or its predecessor) last did.
 *
 * Resolution order:
 *   1. `state.implementation` (preferred — fully populated)
 *   2. fallback: returns a minimal record with only `attemptNumber`
 *
 * The diff is truncated to `PRIOR_DIFF_MAX_BYTES` to keep prompts
 * bounded. The agent is told (in its userPrompt) that the diff may be
 * truncated and that it can fetch the full diff via `git show <sha>`.
 */
export async function buildPriorAttempt(
  state: FactoryIssueState,
  maxAttempts: number,
  cwd: string,
  baseBranch: string,
): Promise<PriorAttempt> {
  const impl = state.implementation;
  if (!impl) {
    return { attemptNumber: (state.attempts ?? 0) + 1, maxAttempts, branch: '', commitSha: '', filesChanged: [], validation: [], diff: '' };
  }
  let diff = '';
  try {
    const out = await exec('git', [
      'diff', '--unified=3',
      `origin/${baseBranch}...${impl.commitSha}`,
    ], { cwd, maxBuffer: 16 * 1024 * 1024 });
    diff = String(out.stdout ?? '');
    if (Buffer.byteLength(diff, 'utf8') > PRIOR_DIFF_MAX_BYTES) {
      const head = diff.slice(0, PRIOR_DIFF_MAX_BYTES);
      diff = `${head}\n\n[... diff truncated at ${PRIOR_DIFF_MAX_BYTES} bytes; fetch the full patch with \`git show ${impl.commitSha}\` or \`git diff origin/${baseBranch}...${impl.commitSha}\` ...]`;
    }
    } catch (error) {
    diff = `Failed to compute prior diff: ${String((error as Error).message ?? error)}`;
  }
  return {
    branch: impl.branch,
    commitSha: impl.commitSha,
    prUrl: impl.prUrl || undefined,
    filesChanged: impl.filesChanged ?? [],
    validation: impl.validation ?? [],
    diff,
    review: state.review,
    behaviorVerification: impl.behaviorVerification,
    attemptNumber: (state.attempts ?? 0) + 1,
    maxAttempts,
  };
}

/**
 * @deprecated Replaced by the unified `agentFailures` counter and the
 * triage supervisor. Retained as a no-op stub for any caller that
 * imported it before the refactor; new code should not reference this
 * symbol.
 */
export function shouldSelfHealImplAttemptLimit(
  state: Pick<FactoryIssueState, 'status' | 'error' | 'attempts'>,
  maxAttempts: number,
): boolean {
  // Triage now judges from `state.error` directly; this predicate is
  // intentionally a no-op so legacy callers do not silently recover
  // failures the supervisor should be deciding.
  void state;
  void maxAttempts;
  return false;
}

/**
 * @deprecated Same as `shouldSelfHealImplAttemptLimit` — the old
 * string-matching self-heal is gone. Triage reads `state.error` and
 * decides what to do.
 */
export function shouldSelfHealStaleParseFailure(
  state: Pick<FactoryIssueState, 'status' | 'error'>,
): boolean {
  void state;
  return false;
}

/**
 * Append a stage event to the durable event log. Kept tiny so it's
 * safe to call on every transition without bloating the checkpoint.
 * Exported for tests so the event-log contract is verifiable without
 * spinning up a full orchestrator.
 */
export function appendEvent(state: FactoryIssueState, event: AgentEvent): void {
  state.events ??= [];
  state.events.push(event);
}

/**
 * Pull a `verdict` field out of a stage result if it has one. Stages
 * that don't produce a verdict (`triage`, `implementation`, `verify`)
 * return undefined, so the event log stays uncluttered.
 */
export function extractVerdict(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const verdict = (result as { verdict?: unknown }).verdict;
  return typeof verdict === 'string' ? verdict : undefined;
}

/** Durable checkpoints own progress; labels expose operator gates, not approval evidence. */
export class FactoryOrchestrator extends EventEmitter {
  private readonly logger = new ConsoleLogger({ orchestrator: 'factory' });
  private readonly loader: SkillLoader;
  private readonly store: IssueStore;
  private readonly repo: AgentContext['repo'];
  private readonly remotePath: string;
  private readonly config: FactoryConfig;

  constructor(opts: {
    skillsRoot: string;
    repo: AgentContext['repo'];
    remotePath?: string;
    config?: FactoryConfig;
  }) {
    super();
    this.config = opts.config ?? resolveFactoryConfig({ cwd: opts.repo.workdir });
    this.repo = opts.repo;
    this.remotePath = opts.remotePath || '';
    this.loader = new SkillLoader(opts.skillsRoot, opts.repo.workdir);
    this.store = new IssueStore(this.config.paths.stateDir);
  }

  /**
   * Resolve the directory where review artefacts (pr_diff.txt,
   * spec_diff.txt, review.json, ...) are staged. The chain is:
   *   1. config.paths.reviewDir (operator override)
   *   2. $RUNNER_TEMP (CI runner temp)
   *   3. ${os.tmpdir()}/factory-review-<issue-number> (local fallback)
   *
   * Staging in a dedicated directory — never in the implementation
   * worktree — keeps the next implementation checkout clean.
   */
  private reviewDirFor(issueNumber: number): string {
    return this.config.paths.reviewDir || process.env.RUNNER_TEMP
      || path.join(os.tmpdir(), `factory-review-${issueNumber}`);
  }

  /**
   * Build the `AgentContext` for one stage.
   *
   * Skill bodies are NOT loaded here. The system prompt advertises each
   * skill by name and description only; the agent fetches the full body
   * via the `load_skill` tool if and when it actually needs the rubric.
   * Inlining every rubric into every prompt spent thousands of tokens
   * per turn on guidance that often went unread.
   *
   * The `spec` stage gets its two sub-skills (`write-product-spec` and
   * `write-tech-spec`) enumerated alongside its primary skill so the
   * agent can pick the right rubric for the half it is drafting.
   */
  private async context(issue: Issue, skill: string, runId = newRunId(), correction?: AgentContext['correction']): Promise<AgentContext> {
    const skills: Array<{ name: string; description: string }> = [];
    for (const name of skill === 'spec'
      ? [skill, 'write-product-spec', 'write-tech-spec']
      : [skill]) {
      const loaded = await this.loader.load(name);
      skills.push({ name: loaded.name, description: loaded.description });
    }
    return {
      repo: this.repo,
      issue,
      skills,
      skillsRoot: this.loader.root,
      logger: this.logger,
      runId,
      correction,
    };
  }

  private async stage<T>(state: FactoryIssueState, name: string, run: () => Promise<T>): Promise<T> {
    state.status = 'running';
    delete state.error;
    state.stages ??= {};
    // M2: every stage run gets a unique runId so retries / revisions /
    // recovery can be cross-referenced without overwriting prior
    // records. The id is stamped on the stage entry AND on the
    // matching start/end events.
    const runId = newRunId();
    state.stages[name] = {
      startedAt: new Date().toISOString(),
      status: 'running',
      runId,
    };
    appendEvent(state, {
      stage: name,
      startedAt: state.stages[name].startedAt,
      status: 'running',
      attempts: state.attempts,
      specAttempts: state.specAttempts,
      reason: `runId=${runId}`,
    });
    await this.store.save(state);
    const projectStatus = projectStatusForStage(name);
    if (projectStatus) await this.syncProject(state.issue, projectStatus);
    this.logger.info(`issue #${state.issue.number} stage=${name} started runId=${runId}`);
    try {
      const result = await run();
      state.stages[name]!.status = 'completed';
      appendEvent(state, {
        stage: name,
        startedAt: state.stages[name]!.startedAt,
        endedAt: new Date().toISOString(),
        status: 'completed',
        attempts: state.attempts,
        specAttempts: state.specAttempts,
        verdict: extractVerdict(result),
        reason: `runId=${runId}`,
      });
      this.emit(name, { issueNumber: state.issue.number, result });
      return result;
    } catch (error) {
      state.stages[name]!.status = 'failed';
      appendEvent(state, {
        stage: name,
        startedAt: state.stages[name]!.startedAt,
        endedAt: new Date().toISOString(),
        status: 'failed',
        attempts: state.attempts,
        specAttempts: state.specAttempts,
        reason: `runId=${runId}; ${String((error as Error).message ?? error)}`,
      });
      throw error;
    } finally {
      state.stages[name]!.endedAt = new Date().toISOString();
      await this.store.save(state);
    }
  }

  private async transition(state: FactoryIssueState, label: TriageLabel, status: FactoryIssueState['status'] = 'running') {
    state.nextLabel = label;
    state.status = status;
    state.labelPending = true;
    await this.store.save(state);
    await syncLabel(state.issue, label, this.config);
    await this.syncProject(state.issue, projectStatusForLabel(label));
    state.labelPending = false;
    await this.store.save(state);
  }

  async runTriage(issue: Issue): Promise<FactoryIssueState> {
    const state: FactoryIssueState = { issue, merged: false, agentMode: 'llm' };
    const result = await this.stage(state, 'triage', async () => new TriageAgent(await this.context(issue, 'triage')).run());
    // The supervisor path returns a TriageRouting; this method is the
    // readiness gate, so we narrow with a runtime check before reading
    // `state`/`label`.
    if (!('state' in result)) throw new Error('Readiness gate expected a triage decision, got a routing');
    state.triage = result;
    await publishTriageDecision(issue, state.triage.comment, this.config);
    await this.transition(state, state.triage.label, 'waiting');
    return state;
  }

  async runForIssue(issue: Issue): Promise<FactoryIssueState> {
    const state = await this.store.load(issue.number) ?? { issue, merged: false, attempts: 0, agentMode: 'llm' as const };
    const changed = JSON.stringify([state.issue.title, state.issue.body, state.issue.comments]) !== JSON.stringify([issue.title, issue.body, issue.comments]);
    state.issue = issue;
    state.agentMode = 'llm';
    if (state.specLoopVersion !== SPEC_LOOP_VERSION) {
      state.specLoopVersion = SPEC_LOOP_VERSION;
      // Older checkpoints carried `specAttempts` capped at 3; the new
      // unified `agentFailures` counter has no per-stage ceiling, so
      // reset the legacy field rather than carrying it forward.
      if (state.specAttempts) state.specAttempts = 0;
    }
    void changed;
    if (state.merged) {
      await syncLabel(issue, null, this.config);
      await this.syncProject(issue, COMPLETED_PROJECT_STATUS);
      return state;
    }
    if (state.status === 'failed') throw new Error(`Task requires operator intervention: ${state.error}`);
    if (state.status === 'simulated') return state;
    if (state.nextLabel && !ALL_FACTORY_LABELS.includes(state.nextLabel as TriageLabel)) {
      delete state.nextLabel;
    }
    if ((issue.labels as string[]).some((label) => RETIRED_FACTORY_LABELS.includes(label as typeof RETIRED_FACTORY_LABELS[number]))) {
      const active = (issue.labels as string[]).find((label) => ALL_FACTORY_LABELS.includes(label as TriageLabel)) as TriageLabel | undefined;
      await syncLabel(issue, state.nextLabel ?? active ?? null, this.config);
      issue.labels = issue.labels.filter((label) => !RETIRED_FACTORY_LABELS.includes(label as typeof RETIRED_FACTORY_LABELS[number]));
    }
    let external = issue.labels.filter((label) => ALL_FACTORY_LABELS.includes(label));
    if (external.length > 1) {
      // Pick the highest-priority label by `ALL_FACTORY_LABELS` order and
      // auto-clear the rest via `syncLabel` on the next transition. This
      // self-heals a common operator mistake (e.g. toggling between
      // ready-to-implement and ready-to-spec) without forcing a manual
      // cleanup. The state-machine order in ALL_FACTORY_LABELS determines
      // which label wins.
      const winner = ALL_FACTORY_LABELS.find((label) => external.includes(label));
      if (winner) {
        await syncLabel(issue, winner, this.config);
        await this.syncProject(issue, projectStatusForLabel(winner));
        external = [winner];
        issue.labels = issue.labels.filter((label) => !ALL_FACTORY_LABELS.includes(label) || label === winner);
      }
    }
    let forceRetriage = false;
    // Source of truth: checkpoint's `state.nextLabel` (set by an agent on
    // its previous pass) wins over any external GitHub label. The old
    // behaviour overwrote `state.nextLabel` with `external[0]`, which
    // meant a stale or operator-edited label on GitHub could rewind
    // the pipeline — e.g. a `needs-info` label that the triage agent
    // had previously resolved would block the next pipeline run.
    if (state.labelPending && state.nextLabel) {
      await this.transition(state, state.nextLabel, state.status);
    } else if (state.status === 'waiting' && !state.nextLabel
        && stageForLabel(external[0] ?? '') === 'triage'
        && (changed || external[0])) {
      // Triage stage never ran (or its result was discarded): use the
      // external label as a hint, falling through to the loop below.
      delete state.triage;
      forceRetriage = true;
    } else if (state.status === 'waiting' && state.nextLabel === 'verify-failed'
        && state.implementation?.behaviorVerification?.status === 'blocked') {
      return state;
    }
    let label = forceRetriage ? null : state.nextLabel ?? null;
    // As a last-resort fallback for issues that have no checkpoint
    // (first poll, freshly created) and DO have an external label
    // that points at a real stage (not triage), use it. Issues that
    // only carry `needs-info` from an old run fall through to triage
    // so the LLM can re-decide.
    if (!label && external[0] && stageForLabel(external[0]) !== 'triage') {
      label = external[0];
    }
    const runId = newRunId();
    const context = (name: string, runIdOverride?: string, correction?: AgentContext['correction']) => this.context(issue, name, runIdOverride ?? runId, correction);
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
        const dispatchStage = label ? stageForLabel(label) : null;
        if (dispatchStage === 'triage') {
          state.status = 'waiting';
          await this.store.save(state);
          return state;
        }
        if (!label) {
          const result = await this.stage(state, 'triage', async () => new TriageAgent(await context('triage')).run());
          if (!('state' in result)) throw new Error('Readiness gate expected a triage decision, got a routing');
          state.triage = result;
          await publishTriageDecision(issue, state.triage.comment, this.config);
          label = state.triage.label;
          await this.transition(state, label, stageForLabel(label) === 'triage' ? 'waiting' : 'running');
          continue;
        }
        if (dispatchStage === 'spec') {
          await this.runSpecPhase(state, issue, context);
          // runSpecPhase advances state.specs / state.specReview and
          // either loops internally on REJECT or sets nextLabel to
          // 'ready-to-implement' on APPROVE. Re-read the label and let
          // the for(;;) loop dispatch into the implementation branch.
          label = state.nextLabel ?? label;
          continue;
        }
        if (dispatchStage === 'implementation') {
          if (state.specs) {
            // Approved specifications must exist on the base checkout, not just in a lost temporary clone.
            for (const [slug, name] of [[state.specs.product.slug, 'PRODUCT.md'], [state.specs.tech.slug, 'TECH.md']]) {
              await exec('git', ['cat-file', '-e', `origin/${this.repo.defaultBranch}:specs/${slug}/${name}`], { cwd: this.repo.workdir });
            }
          }
          const ctx = await context('implementation', undefined, state.correction);
          // Build the typed prior-attempt artifact so the
          // ImplementationAgent has structured access to the previous
          // commit / diff / review. It is rendered into a follow-up user
          // turn (contextTurns) by the agent — NOT concatenated into
          // ctx.skills, which is part of the immutable systemPrompt.
          // Mutating skills here would bust the provider prompt cache
          // on every retry.
          ctx.priorAttempt = await buildPriorAttempt(state, this.config.limits.agentFailures, this.repo.workdir, this.repo.defaultBranch);
          state.attempts = (state.attempts ?? 0) + 1;
          // Belt + suspenders: belt was moving review artefacts out of
          // repo.workdir; this is the suspenders. If anything ever leaks
          // again (a new staging path added without updating the helper),
          // we forcibly untrack spec/pr temp files here so the
          // implementation agent starts from a clean working tree.
          await exec('git', ['rm', '--cached', '--ignore-unmatch',
            'spec_description.txt', 'spec_diff.txt', 'spec_product.md',
            'spec_review.json', 'spec_tech.md',
            'pr_diff.txt', 'pr_description.txt', 'review.json',
          ], { cwd: this.repo.workdir }).catch(() => {});
          await exec('rm', ['-f',
            'spec_description.txt', 'spec_diff.txt', 'spec_product.md',
            'spec_review.json', 'spec_tech.md',
            'pr_diff.txt', 'pr_description.txt', 'review.json',
          ], { cwd: this.repo.workdir }).catch(() => {});
          // The implementation agent itself commits + pushes + opens
          // the PR (see ImplementationAgent.run: it has write_file +
          // commit_and_push + open_pull_request in its tool list). The
          // returned checkpoint therefore already carries a real
          // commitSha and PR URL; we just store it and let the
          // acceptance contract verify the worktree state.
          state.implementation = await this.stage(state, 'implementation', () => new ImplementationAgent(ctx, this.remotePath).run());
          // Implementation Acceptance Contract: the agent may have
          // produced text and tool calls but not actually committed
          // and pushed the change. Without this gate the next stage
          // (review-pr) would fail with "implementation commit not
          // found on origin", and triage-supervisor would flag it as
          // a generic "implementation failed" symptom that retries
          // never fix. Enforce the contract here so the failure
          // message is concrete and actionable.
          try {
            await assertImplementationContract(state.implementation, this.repo, state.issue.number, this.config);
          } catch (error) {
            // Contract failed: discard the failed implementation so
            // the next poll does not route into review against a
            // half-finalised commit, and let triage-supervisor see a
            // clean "implementation stage failed: <reason>" envelope
            // it can route back to implementation-retry.
            delete state.implementation;
            delete state.review;
            delete state.reviewedSha;
            delete state.reviewedBaseSha;
            delete state.verifiedSha;
            throw error;
          }
          delete state.review;
          delete state.reviewedSha;
          delete state.verifiedSha;
          delete state.implementation.behaviorVerification;
          label = 'review-needed';
          await this.transition(state, label);
          continue;
        }
        if (dispatchStage === 'review' || dispatchStage === 'verify' || dispatchStage === 'merge') {
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
            // Surface the verdict to the issue thread on the same
            // dispatch that runs the review, so an operator reading
            // the issue sees the review outcome without scrolling the
            // PR review thread. Dedup on the body hash means the
            // call is silent on review-cache hits and on retries
            // after a transient publish failure.
            //
            // Publish failures (GraphQL EOF, label-update flake) MUST
            // NOT cascade into a review-stage failure: the verdict is
            // already decided and stored on state.review. If we let the
            // catch bubble up, triage-supervisor sees `stage: review`
            // as failed and routes the issue back into review forever.
            try {
              await publishReviewDecision(issue, state.review, this.config);
            } catch (publishError) {
              this.logger.warn(`issue #${issue.number} review publish failed (continuing): ${String(publishError).slice(0, 500)}`);
            }
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
          if (!this.config.autoMerge) { await this.transition(state, 'verified', 'waiting'); return state; }
          await this.stage(state, 'merge', async () => mergePullRequest({ workdir: this.repo.workdir, remotePath: this.remotePath, prUrl: implementation.prUrl, expectedHeadSha: sha }));
          state.merged = true;
          state.status = 'completed';
          await this.store.save(state);
          await syncLabel(issue, null, this.config);
          await this.syncProject(issue, COMPLETED_PROJECT_STATUS);
          this.emit('merged', { issueNumber: issue.number });
          return state;
        }
        // Unrecognized label (e.g. a legacy `spec-ready-for-review` left
        // over by an older factory version). Self-heal by clearing
        // state.nextLabel and routing through triage, which will
        // re-classify the issue under the current rule grammar.
        this.logger.warn(`issue #${issue.number} unrecognized label=${label}; self-healing via triage`);
        delete state.nextLabel;
        label = null;
        continue;
      }
    } catch (error) {
      // Unified failure path. Every stage's failure lands here, and
      // triage judges what to do — retry the same stage, reroute to a
      // different one, flag the issue as needs-info, or abort.
      // The previous design hard-coded `attempts >= 3 ? 'failed' : 'waiting'`
      // and special-cased `ImplementationParseError`; both decisions are
      // now the supervisor's, not code's.
      await this.handleStageFailure(state, issue, context, error as Error);
    }
    // After handleStageFailure mutates state (retry / reroute / abort),
    // the for-loop will dispatch again — but only when the supervisor's
    // action lets the pipeline continue. When it lands here, the loop
    // has not re-entered, so return the (possibly failed) state.
    return state;
  }

  /**
   * Hand a stage failure to the triage supervisor and apply the routing.
   *
   * What this method does NOT decide:
   *   - whether to retry vs reroute vs needs-info vs abort;
   *   - what corrective prompt to send on a retry;
   *   - what the issue thread comment should say.
   *
   * What this method DOES decide:
   *   - the mechanical loop cap (FACTORY_MAX_AGENT_FAILURES);
   *   - how to translate each routing action into state mutations
   *     (nextLabel, status, correction turns, clear-and-restart);
   *   - the durable audit trail for the supervisor's judgment.
   */
  private async handleStageFailure(
    state: FactoryIssueState,
    issue: Issue,
    context: (name: string) => Promise<AgentContext>,
    error: Error,
  ): Promise<void> {
    state.agentFailures = (state.agentFailures ?? 0) + 1;
    if (state.agentFailures > this.config.limits.agentFailures) {
      state.status = 'failed';
      state.error = `Pipeline failed ${state.agentFailures} times (FACTORY_MAX_AGENT_FAILURES=${this.config.limits.agentFailures}); last error: ${error.message}`;
      await this.store.save(state);
      throw new Error(state.error);
    }

    const lastStage = lastStageName(state);
    const receiptRegistry = consumeReceiptRegistry();
    const evidence = receiptRegistry ? { verifyReceipts: receiptRegistry } : undefined;
    const failure: PipelineFailure = {
      stage: lastStage ?? 'unknown',
      agentName: lastStage ?? 'unknown',
      attempt: state.agentFailures,
      error: error.message,
      priorEvents: state.events ?? [],
      evidence,
    };
    let routing: TriageRouting;
    try {
      routing = await this.stage(state, 'triage-supervisor', async () => new TriageAgent(await context('triage'), failure).run()) as TriageRouting;
    } catch (supervisorError) {
      // Supervisor itself failed. Treat as abort — there is nothing
      // left to ask an LLM.
      state.status = 'failed';
      state.error = `Triage supervisor failed: ${(supervisorError as Error).message}; original failure: ${error.message}`;
      await this.store.save(state);
      throw supervisorError;
    }
    if (!routing || !('action' in routing)) {
      state.status = 'failed';
      state.error = `Triage supervisor returned an unexpected shape: ${JSON.stringify(routing)}`;
      await this.store.save(state);
      throw new Error(state.error);
    }

    appendEvent(state, {
      stage: 'orchestrator',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'self-healed',
      attempts: state.attempts,
      reason: `triage supervisor: ${routing.action} → ${routing.targetStage || 'n/a'}`,
    });

    // Apply routing. Every action resets enough state that the next
    // loop iteration lands on a clean dispatch for the chosen target.
    if (routing.action === 'retry') {
      const target = routing.targetStage || lastStage || 'implementation';
      state.correction = { targetStage: target, turns: routing.correction };
      setNextLabelForStage(state, target);
      delete state.error;
      await this.store.save(state);
      return;
    }
    if (routing.action === 'reroute') {
      const target = routing.targetStage;
      // Wipe stage-specific state so the rerouted target starts clean.
      delete state.specs; delete state.specReview; delete state.specReviewedKey;
      delete state.implementation; delete state.review;
      delete state.reviewedSha; delete state.reviewedBaseSha; delete state.verifiedSha;
      delete state.correction;
      setNextLabelForStage(state, target);
      await syncLabel(issue, null, this.config);
      delete state.error;
      await this.store.save(state);
      return;
    }
    if (routing.action === 'needs-info') {
      state.nextLabel = 'needs-info';
      state.status = 'waiting';
      delete state.correction;
      await this.transition(state, 'needs-info', 'waiting');
      if (routing.comment) await publishTriageDecision(issue, routing.comment, this.config);
      return;
    }
    // abort — surface as a hard failure with the supervisor's reason.
    state.status = 'failed';
    state.error = routing.comment || `Triage supervisor aborted: ${error.message}`;
    delete state.correction;
    await this.store.save(state);
    throw new Error(state.error);
  }

  private async prepareReviewArtifacts(state: FactoryIssueState) {
    const patch = (await exec('git', ['diff', '--unified=3', `origin/${this.repo.defaultBranch}...${state.implementation!.commitSha}`], { cwd: this.repo.workdir, maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (!patch.trim()) throw new Error('Review diff is empty');
    // (Full body of prepareReviewArtifacts follows below in the
    // orchestrator's review pipeline; see further down in this file.)
    // ("Target checkout is not clean").
    const reviewDir = this.reviewDirFor(state.issue.number);
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(path.join(reviewDir, 'pr_diff.txt'), annotateDiff(patch));
    await fs.writeFile(path.join(reviewDir, 'pr_description.txt'), state.implementation!.comment);
  }

  /**
   * Run SpecAgent + ReviewSpecAgent in a self-resolving loop. The loop
   * terminates when ReviewSpecAgent returns APPROVE — at that point the
   * spec PR is auto-merged into base, the issue transitions to
   * `ready-to-implement`, and the caller's for(;;) picks up the next
   * stage on the next iteration.
   *
   * The previous design capped spec revisions at three and silently
   * demoted the issue to `needs-info`. Now there is no per-stage cap:
   * if the spec/review pipeline cannot converge, the caller's outer
   * catch routes the failure to the triage supervisor, which decides
   * whether to retry, reroute, ask a human, or abort.
   *
   * The only local check kept is the "two regenerations produced no
   * material change" stalemate. That is a deterministic local
   * observation (no judgment needed), not a routing decision — when it
   * fires we throw so the supervisor can decide.
   */
  private async runSpecPhase(state: FactoryIssueState, issue: Issue, context: (name: string, runIdOverride?: string, correction?: AgentContext['correction']) => Promise<AgentContext>): Promise<void> {
    if (state.specs?.specBranch && state.specReview?.verdict === 'REJECT') {
      await exec('git', ['fetch', 'origin', state.specs.specBranch, this.repo.defaultBranch], { cwd: this.repo.workdir });
      await exec('git', ['checkout', '-B', state.specs.specBranch, `origin/${state.specs.specBranch}`], { cwd: this.repo.workdir });
    }
    while (true) {
      const previousSpecs = state.specs;
      const revision = state.specReview?.verdict === 'REJECT' && previousSpecs
        ? {
            feedback: buildSpecFeedback(state),
            previousProductBody: previousSpecs.product.body,
            previousTechBody: previousSpecs.tech.body,
          }
        : undefined;
      let nextSpecs;
      for (let generationAttempt = 1; generationAttempt <= 2; generationAttempt += 1) {
        const specCtx = await context('spec', undefined, state.correction);
        const attemptRevision = revision && generationAttempt === 2
          ? { ...revision, feedback: `${revision.feedback}\n\nThe last regeneration was unchanged. Make concrete edits in the files before returning.` }
          : revision;
        const candidate = await this.stage(state, 'spec', () => new SpecAgent(specCtx, attemptRevision).run());
        if (!previousSpecs || specBodiesChanged(previousSpecs, candidate)) {
          nextSpecs = candidate;
          break;
        }
        this.logger.warn(`issue #${issue.number} spec regeneration produced no material changes (${generationAttempt}/2)`);
      }
      if (!nextSpecs) {
        throw new Error('Spec revision produced no material change after two regenerations; triage will judge next steps');
      }
      state.specs = nextSpecs;
      const spec = state.specs;
      // The spec agent has write_file in its tool list (see SpecAgent
      // tools), so it writes PRODUCT.md / TECH.md directly to the
      // worktree. We trust the agent's output here: commit the
      // resulting files (whatever they are) rather than re-writing
      // them from the structured body, which would race with the
      // agent and lose any user-driven edits the agent made to the
      // file (e.g. alignment, whitespace, tool-applied formatting).
      const specCtxForCommit = await context('spec');
      const commit = await commitAndPushTool(specCtxForCommit).execute({ branch: spec.specBranch, message: `Specify issue #${issue.number}` }, specCtxForCommit) as { ok: boolean; commitSha: string };
      if (!commit.ok) throw new Error('Specification publication failed');
      const pr = await openPullRequestTool(specCtxForCommit, this.remotePath).execute({ branch: spec.specBranch, title: `Spec: ${issue.title}`, body: `Specifications for #${issue.number}. Auto-reviewed by the factory and merged once approved.`, baseBranch: this.repo.defaultBranch }, specCtxForCommit) as { prUrl: string; headSha: string };
      if (!pr.prUrl || pr.headSha !== commit.commitSha) throw new Error('Specification PR not confirmed');
      spec.specPrUrl = pr.prUrl;
      spec.commitSha = commit.commitSha;
      // ReviewSpecAgent. Cache by specBranch + commitSha so a re-run
      // with the same spec reuses the prior verdict (mirrors the
      // implementation-phase review cache at :183-193).
      const reviewKey = `${spec.specBranch}@${commit.commitSha}`;
      if (!state.specReview || state.specReviewedKey !== reviewKey) {
        await this.prepareSpecReviewArtifacts(state, commit.commitSha, pr.prUrl);
        const reviewCtx = await context('review-spec', undefined, state.correction);
        state.specReview = await this.stage(state, 'review-spec', () => new ReviewSpecAgent(reviewCtx).run());
        state.specReviewedKey = reviewKey;
      }
      await publishSpecReviewDecision(issue, state.specReview, this.config);
      if (state.specReview.verdict === 'REJECT') {
        await this.store.save(state);
        this.logger.warn(`issue #${issue.number} spec review REJECTED — handing back to triage for routing`);
        throw new Error(`Spec review REJECTED: ${state.specReview.body}`);
      }
      this.logger.info(`issue #${issue.number} spec review APPROVED`);
      await this.stage(state, 'merge-spec-pr', async () => mergePullRequest({ workdir: this.repo.workdir, remotePath: this.remotePath, prUrl: pr.prUrl, expectedHeadSha: commit.commitSha }));
      await exec('git', ['fetch', 'origin', this.repo.defaultBranch], { cwd: this.repo.workdir });
      // Clear any pending correction once the spec phase succeeds — the
      // next stage starts from a clean correction slate.
      delete state.correction;
      await this.transition(state, 'ready-to-implement', 'running');
      return;
    }
  }

  private async syncProject(issue: Issue, status: ProjectStatus): Promise<void> {
    if (!this.config.syncProjects) return;
    const token = this.config.github.token;
    const repo = this.config.github.repository || `${this.repo.owner}/${this.repo.name}`;
    if (!token || !repo) return;
    try {
      const result = await syncIssueProjectStatus({ repo, issueNumber: issue.number, status, token });
      if (result.projectsFound > 0) {
        this.logger.info(`issue #${issue.number} project status=${status} projects=${result.projectsFound} added=${result.itemsAdded} updated=${result.itemsUpdated}`);
      }
      for (const warning of result.warnings) this.logger.warn(`issue #${issue.number} project sync: ${warning}`);
    } catch (error) {
      this.logger.warn(`issue #${issue.number} project sync failed for status=${status}: ${String(error)}`);
    }
  }

  /**
   * Stage the spec PR diff + PRODUCT.md / TECH.md bodies for the
   * ReviewSpecAgent. Mirrors `prepareReviewArtifacts` for the
   * implementation-review path.
   */
  private async prepareSpecReviewArtifacts(state: FactoryIssueState, specCommitSha: string, specPrUrl: string): Promise<void> {
    // Spec PRs are pure additions (PRODUCT.md + TECH.md only), so a
    // diff against the base SHA before this commit is exactly the spec
    // content. If the spec PR has touched other files in a future
    // expansion the diff still captures them.
    const baseSha = (await exec('git', ['rev-parse', `origin/${this.repo.defaultBranch}`], { cwd: this.repo.workdir })).stdout.trim();
    const patch = (await exec('git', ['diff', '--unified=3', `${baseSha}...${specCommitSha}`], { cwd: this.repo.workdir, maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (!patch.trim()) throw new Error('Spec review diff is empty');
    const reviewDir = this.reviewDirFor(state.issue.number);
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(path.join(reviewDir, 'spec_diff.txt'), annotateDiff(patch));
    await fs.writeFile(path.join(reviewDir, 'spec_product.md'), state.specs!.product.body);
    await fs.writeFile(path.join(reviewDir, 'spec_tech.md'), state.specs!.tech.body);
    await fs.writeFile(path.join(reviewDir, 'spec_description.txt'), `Spec PR for issue #${state.issue.number}\nURL: ${specPrUrl}\n`);
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
    const reviewDir = this.reviewDirFor(issue.number);
    const diff = await fs.readFile(path.join(reviewDir, 'pr_diff.txt'), 'utf8');
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

async function syncLabel(issue: Issue, label: TriageLabel | null, config: FactoryConfig) {
  if (!config.syncLabels) return;
  const repo = config.github.repository;
  const token = config.github.token;
  if (!repo || !token) return;
  const env = { ...process.env, GH_TOKEN: token };
  const current = JSON.parse((await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'labels'], { env })).stdout).labels.map((item: { name: string }) => item.name);
  if (label) await exec('gh', ['label', 'create', label, '--repo', repo, '--color', '5319E7', '--force'], { env });
  const args = ['issue', 'edit', String(issue.number), '--repo', repo];
  for (const old of current) if (FACTORY_LABELS_TO_CLEAR.includes(old) && old !== label) args.push('--remove-label', old);
  if (label && !current.includes(label)) args.push('--add-label', label);
  if (args.length > 5) await exec('gh', args, { env });
}

async function publishTriageDecision(issue: Issue, comment: string, config: FactoryConfig) {
  if (!config.syncLabels) return;
  const repo = config.github.repository;
  const token = config.github.token;
  if (!repo || !token) return;
  const marker = `<!-- pi-software-factory:triage:${issue.number}:${createHash('sha256').update(comment).digest('hex').slice(0, 16)} -->`;
  const env = { ...process.env, GH_TOKEN: token };
  const current = JSON.parse((await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments'], { env })).stdout) as { comments?: Array<{ body?: string }> };
  if (current.comments?.some((entry) => entry.body?.includes(marker))) return;
  await exec('gh', ['issue', 'comment', String(issue.number), '--repo', repo, '--body', `${comment}\n\n${marker}`], { env });
}

// NOTE: the old `buildImplementationFeedback` markdown helper was removed.
// Its content (review verdict/body/comments + behavior-verification notes
// and evidence) is fully covered by the typed `PriorAttempt` artifact,
// which `renderPriorAttempt` in agents/implementation.ts formats into a
// follow-up user turn. Keeping the markdown copy alive meant concatenating
// dynamic feedback into ctx.skillBody — part of the systemPrompt — which
// busted the provider prompt cache on every retry.

/**
 * Build a text feedback payload from the most recent spec review so the
 * next SpecAgent attempt can act on it. Delivered to the LLM as a
 * follow-up user turn (see `formatSpecRevisionPrompt`), never as part of
 * the systemPrompt, so the cached prefix survives revision attempts.
 */
function buildSpecFeedback(state: FactoryIssueState): string {
    const review = state.specReview;
    if (!review || review.verdict !== 'REJECT') return 'Fresh spec pass; no prior feedback.';
    const lines: string[] = [];
    lines.push(`Spec review REJECTED the previous attempt. Body:`, review.body || '(no body)');
    for (const c of review.comments ?? []) {
        lines.push(`- ${c.path}:${c.line}  ${c.body}`);
    }
    if (review.notes) {
        lines.push('', `Reviewer notes: ${review.notes}`);
    }
    lines.push(
        ``,
        `Address every review comment before opening a new spec PR. Do NOT just re-submit — PRODUCT.md and TECH.md must be materially different.`,
    );
    return lines.join('\n');
}

/**
 * Post the spec-review verdict to the issue as a comment so the trail
 * is auditable. Mirrors `publishTriageDecision` but uses a different
 * comment tag so the two streams don't collide on re-post detection.
 */
async function publishSpecReviewDecision(issue: Issue, review: { verdict: string; body: string; notes?: string }, config: FactoryConfig) {
    if (!config.syncLabels) return;
    const repo = config.github.repository;
    const token = config.github.token;
    if (!repo || !token) return;
    const marker = `<!-- pi-software-factory:spec-review:${issue.number}:${createHash('sha256').update(review.body + (review.notes ?? '')).digest('hex').slice(0, 16)} -->`;
    const env = { ...process.env, GH_TOKEN: token };
    const current = JSON.parse((await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments'], { env })).stdout) as { comments?: Array<{ body?: string }> };
    if (current.comments?.some((entry) => entry.body?.includes(marker))) return;
    const body = [
        `**Spec review: ${review.verdict}**`,
        ``,
        review.body,
        review.notes ? `\n${review.notes}` : '',
        ``,
        marker,
    ].join('\n');
    await exec('gh', ['issue', 'comment', String(issue.number), '--repo', repo, '--body', body], { env });
}

/**
 * Post the implementation-PR review verdict to the issue as a comment
 * so the trail is auditable from the issue (not just the PR review
 * thread). Mirrors `publishSpecReviewDecision` and `publishTriageDecision`
 * but uses a distinct `pr-review` marker namespace so the three streams
 * don't collide on re-post detection. `ReviewResult` does not carry a
 * `notes` field (unlike `SpecReviewResult`), so only verdict + body are
 * posted.
 */
async function publishReviewDecision(issue: Issue, review: { verdict: string; body: string }, config: FactoryConfig) {
    if (!config.syncLabels) return;
    const repo = config.github.repository;
    const token = config.github.token;
    if (!repo || !token) return;
    const marker = `<!-- pi-software-factory:pr-review:${issue.number}:${createHash('sha256').update(review.body).digest('hex').slice(0, 16)} -->`;
    const env = { ...process.env, GH_TOKEN: token };
    const current = JSON.parse((await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments'], { env })).stdout) as { comments?: Array<{ body?: string }> };
    if (current.comments?.some((entry) => entry.body?.includes(marker))) return;
    const body = [
        `**PR review: ${review.verdict}**`,
        ``,
        review.body,
        ``,
        marker,
    ].join('\n');
    await exec('gh', ['issue', 'comment', String(issue.number), '--repo', repo, '--body', body], { env });
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

function setNextLabelForStage(state: FactoryIssueState, stage: string): void {
  const normalized = normalizeStageId(stage);
  if (!normalized) throw new Error(`Triage supervisor selected an unknown stage: ${stage}`);
  const label = pipelineLabelForStage(normalized);
  if (!label) {
    if (normalized !== 'triage') {
      throw new Error(`Triage supervisor selected a non-dispatchable stage: ${stage}`);
    }
    delete state.nextLabel;
    return;
  }
  state.nextLabel = label;
}

/**
 * Return the name of the most recently started stage, used to populate
 * `PipelineFailure.stage` / `.agentName` when the catch fires. Returns
 * undefined when no stage has run yet (the failure came from outside
 * any agent, e.g. a git checkout error).
 */
function lastStageName(state: FactoryIssueState): string | undefined {
  const stages = state.stages;
  if (!stages) return undefined;
  let latest: string | undefined;
  let latestTime = -1;
  for (const [name, info] of Object.entries(stages)) {
    const t = Date.parse(info.startedAt);
    if (!Number.isNaN(t) && t > latestTime) {
      latestTime = t;
      latest = name;
    }
  }
  return latest;
}
