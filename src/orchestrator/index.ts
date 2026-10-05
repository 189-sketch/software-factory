import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConsoleLogger } from '../core/log.js';
import { SkillLoader } from '../core/skill.js';
import { newRunId, getDefaultAgentRuntime } from '../core/agent-runtime.js';
import { IssueStore, type IssueStateStore } from '../core/state.js';
import { GitHubIssueStore } from '../core/github-issue-store.js';
import { businessInputHash } from '../../runtime/business-input.mjs';
import { relocateLegacyEvidence } from '../../runtime/evidence-store.mjs';
import { runExternalOp, findExternalOp, finishExternalOp } from '../core/external-op-ledger.js';
import { ALL_FACTORY_LABELS, RETIRED_FACTORY_LABELS, type AgentContext, type FactoryIssueState, type Issue, type PipelineFailure, type TriageLabel } from '../core/types.js';
import { buildStageInputManifest, summarizeManifest, type StageInputManifest } from '../core/stage-input-manifest.js';
import {
  recordSpecArtifacts,
  recordSpecReviewArtifact,
  recordImplementationArtifacts,
  recordReviewPrArtifact,
  recordVerifyEvidenceArtifact,
} from '../core/artifact-tracker.js';
import { classifyError, bumpFailureCount, DEFAULT_FAILURE_POLICY } from '../core/failure-classifier.js';
import { resetFailedState } from '../core/orchestrator-reset.js';
import { decideRouting } from '../core/routing-decision.js';
import {
  attachResumeSessionId,
  bindProviderSession,
  getProviderSession,
} from '../core/provider-session.js';
import { hasAuthorCommentAfter } from '../core/factory-comments.js';
import { TriageAgent, type TriageCache } from '../agents/triage.js';
import { ImplementationAgent } from '../agents/implementation.js';
import { ReviewPrAgent } from '../agents/review-pr.js';
import { VerifyBehaviorAgent, consumeReceiptRegistry } from '../agents/verify-behavior.js';
import { ImproveReviewPrAgent } from '../agents/improve-review-pr.js';
import { runDecisionsPreCheckSync } from '../core/decisions.js';
import { buildJudgmentState, stateHashFor } from '../core/judgment-state.js';
import { primeDefaultWeights } from './composite.js';
import { mergePullRequest, runGitNetworkCommand } from '../github/git.js';
import { projectStatusForLabel, projectStatusForStage, syncIssueProjectStatus, type ProjectStatus } from '../github/project.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import type { FactoryConfig } from '../../runtime/factory-config.mjs';
import {
  COMPLETED_PROJECT_STATUS,
  labelForStage as pipelineLabelForStage,
  normalizeStageId,
  stageForLabel,
} from '../../runtime/pipeline-definition.mjs';
import { fetchPullRequest, fetchIssue, closeIssue } from '../../runtime/github-rest.mjs';
import { hasAcceptanceCoverage, hasImplementationApproval, hasVerificationJudgment } from '../core/completion-contract.js';
import { advanceVerificationRecovery, hasProductVerificationFailure } from '../core/verification-recovery.js';
import { needsJudgmentRecovery, judgmentRetryPending, scheduleJudgmentRetry } from '../../runtime/judgment-recovery.mjs';
import { assertImplementationContract, canConfirmMergedImplementation } from './contracts.js';
import { buildPriorAttempt } from './prior-attempt.js';
import { reroutePreservedFields, clearRerouteInvalidatedFields } from './reroute.js';
import { appendEvent, extractVerdict } from './event-log.js';
import { hasSpecificationApproval, resolveSpecFallbackRef } from './spec-fallback.js';
import { syncLabel, publishTriageDecision, publishReviewDecision } from './decision-publish.js';
import { prepareReviewArtifacts, prepareSpecReviewArtifacts } from './review-artifacts.js';
import { runSpecPhaseBody } from './spec-phase.js';

export * from './contracts.js';
export * from './limits.js';
export * from './prior-attempt.js';
export * from './reroute.js';
export * from './event-log.js';
export * from './spec-fallback.js';
export * from './decision-publish.js';
export * from './review-artifacts.js';
export * from './spec-phase.js';


const exec = promisify(execFile);
const SPEC_LOOP_VERSION = 2;

/** Durable checkpoints own progress; labels expose operator gates, not approval evidence. */
export class FactoryOrchestrator extends EventEmitter {
  private readonly logger = new ConsoleLogger({ orchestrator: 'factory' });
  private readonly loader: SkillLoader;
  private readonly store: IssueStateStore;
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
    this.store = this.config.state.backend === 'github'
      ? new GitHubIssueStore({
        repository: this.config.github.repository, token: this.config.github.token,
        stateDir: this.config.paths.stateDir, leaseSha: this.config.state.leaseSha,
        writers: this.config.state.writers, defaultBranch: this.repo.defaultBranch,
        staleMs: this.config.lease.staleMs,
      })
      : new IssueStore(this.config.paths.stateDir);
    // `decisions.yaml` startup pre-check (spec
    // `2026-09-20-decision-architecture` / Phase B / T8.3). Mirrors
    // the F01 `load_skill` regression severity: a missing or
    // schema-invalid file aborts startup with an `Error` whose message
    // starts with `Invalid decisions.yaml:`, exactly the shape used by
    // `runtime/agent-backends.mjs::resolveAgentConfig`
    // (`Invalid FACTORY_AGENT backend: ...`). Runs synchronously so
    // a bad YAML fails the constructor before any `runForIssue` call.
    // The cached default weights are primed here so subsequent
    // `computeHealth()` calls inside `composite.ts` skip the async
    // re-read.
    const decisions = runDecisionsPreCheckSync();
    primeDefaultWeights(decisions);
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
      commandTimeoutMs: this.config.limits.commandTimeoutMs,
      artifactStateDir: this.config.paths.stateDir,
    };
  }

  /**
   * M6: bind the orchestrator-side session lifecycle for `role` around
   * one agent invocation. Before `run()` is called, the helper looks up
   * the live binding (guarded by backend + model) and stuffs its
   * providerSessionId onto `ctx.resumeSessionId`, which `dispatchAgentStage`
   * reads to thread `--resume <id>` into the CLI. After `run()` returns
   * — even on throw — the helper persists the new session id (written
   * by the dispatcher to `ctx.lastProviderSessionId`) onto
   * `state.providerSessions[role]` so the next attempt can resume.
   *
   * Call sites wrap their `new XxxAgent(ctx).run()` inside this helper;
   * the `stage()` wrapper above stays session-agnostic.
   */
  private async withProviderSession<T>(
    state: FactoryIssueState,
    role: string,
    ctx: AgentContext,
    run: () => Promise<T>,
  ): Promise<T> {
    const resolved = getDefaultAgentRuntime().selectBackend(role);
    const backend = resolved.selection.backend;
    const model = resolved.selection.model ?? '';
    const inputRevision = role === 'review-spec' ? state.specs?.commitSha
      : role === 'review-pr' ? state.implementation?.commitSha
      : role === 'verify-behavior' ? `${state.implementation?.commitSha ?? 'unknown'}:${ctx.runId}` : undefined;
    const binding = getProviderSession(state, role, backend, model, ctx.repo.workdir, inputRevision);
    attachResumeSessionId(ctx, binding);
    try {
      return await run();
    } finally {
      const next = ctx.lastProviderSessionId;
      if (next) {
        bindProviderSession(state, role, {
          providerSessionId: next,
          backend,
          model,
          workdir: ctx.repo.workdir,
          inputRevision,
        });
      }
    }
  }

  private async stage<T>(state: FactoryIssueState, name: string, run: () => Promise<T>): Promise<T> {
    // M2 status separation (plan §3.3): `state.status` is the task
    // lifecycle (queued / waiting / completed / failed / cancelled) and
    // is set by the orchestrator's transition() — never by the stage
    // wrapper. `state.stages[name].status` is the stage-run execution
    // (queued / running / succeeded / failed / interrupted) and is
    // what this wrapper owns. The previous implementation stomped
    // `state.status = 'running'` on every stage entry, which made it
    // impossible to distinguish "the task is waiting on a previous
    // stage's verdict" from "this stage just started running".
    delete state.error;
    state.stages ??= {};
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
    // M3 plan §3.4: the model must see a typed manifest of every input
    // it will read *before* its first tool call. Persist the manifest
    // as a stage-input-manifest event so a recovery walk can rebuild
    // what the agent saw and a later reviewer can verify file hashes
    // against the worktree.
    const manifest = buildStageInputManifest(state, name, runId, this.repo.workdir);
    appendEvent(state, {
      stage: name,
      startedAt: state.stages[name].startedAt,
      endedAt: new Date().toISOString(),
      status: 'completed',
      reason: summarizeManifest(manifest),
      verdict: JSON.stringify(manifest),
    });
    this.logger.info(`issue #${state.issue.number} stage=${name} input-manifest ${summarizeManifest(manifest)}`);
    await this.store.save(state);
    const projectStatus = projectStatusForStage(name);
    if (projectStatus) await this.syncProject(state, projectStatus);
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
      // M5: capture the artifact the just-completed stage produced
      // before the next save() flushes the checkpoint. This is the
      // single hook that turns the previously-declared-but-never-
      // -populated `state.artifacts[]` into a real audit trail.
      state.artifacts = recordStageArtifacts(state, name, runId, result);
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
      if (name === 'triage' && state.stages[name]!.status === 'completed') {
        state.lastTriageAt = state.stages[name]!.endedAt;
        state.lastJudgmentHash = stateHashFor(buildJudgmentState(state.issue, {
          factory: { failureCounts: state.failureCounts ?? {}, lastTriageAt: state.lastTriageAt },
        }));
      }
      await this.store.save(state);
    }
  }

  private async transition(state: FactoryIssueState, label: TriageLabel, status: FactoryIssueState['status'] = 'waiting', preserveWait = false) {
    const retryLabel = state.wait?.reason === 'judgment-retry'
      && label === (state.wait.stage === 'review' ? 'review-needed' : 'ready-to-merge');
    if (!preserveWait && !retryLabel && !['wait-to-implement', 'needs-info', 'verify-failed', 'verified'].includes(label)) delete state.wait;
    state.nextLabel = label;
    state.status = status;
    state.labelPending = true;
    await this.store.save(state);
    await syncLabel(state, label, this.config, this.store);
    await this.syncProject(state, projectStatusForLabel(label));
    state.labelPending = false;
    state.issue.labels = [...state.issue.labels.filter((current) => !ALL_FACTORY_LABELS.includes(current)), label];
    state.lastJudgmentHash = businessInputHash(state.issue);
    await this.store.save(state);
  }

  private async waitForOperator(state: FactoryIssueState, label: TriageLabel, note: string): Promise<void> {
    state.wait = { reason: 'blocked-operator', note, since: new Date().toISOString() };
    try {
      await this.transition(state, label, 'waiting', true);
    } catch (error) {
      if (String((error as { code?: string }).code ?? '').startsWith('FACTORY_STATE_')) throw error;
      state.nextLabel = label;
      state.status = 'waiting';
      await this.store.save(state);
      this.logger.warn(`issue #${state.issue.number} wait label sync failed: ${String(error)}`);
    }
    try {
      await publishTriageDecision(state, `**需要你的操作**\n\n${note}`, this.config, this.store);
    } catch (error) {
      if (String((error as { code?: string }).code ?? '').startsWith('FACTORY_STATE_')) throw error;
      this.logger.warn(`issue #${state.issue.number} action-required comment failed: ${String(error)}`);
    }
  }

  private triageWaitNote(state: FactoryIssueState): string {
    if (state.specReview?.verdict === 'REJECT') {
      const pr = state.specs?.specPrUrl ?? '当前规格 PR';
      return `规格审查仍为 REJECT（${pr}）。请在本 issue 明确选择：修订规格以解决审查发现，或确认按当前规格继续并接受列出的非安全风险。不要直接合并被拒绝的规格 PR；收到新回复后工厂会重新判断。`;
    }
    return '工厂选择了 Wait to implement，但未记录可自动检测的解除条件。请在本 issue 指明尚待完成的依赖或明确要求继续实现；收到新回复后工厂会重新判断。';
  }

  private async waitForJudgment(state: FactoryIssueState, stage: 'review' | 'verify'): Promise<void> {
    const failure = stage === 'review' ? state.review?.judgmentFailure : state.implementation?.behaviorVerification?.judgmentFailure;
    if (failure?.kind !== 'transient') {
      await this.waitForOperator(state, stage === 'review' ? 'review-needed' : 'verify-failed',
        `${stage} 独立判断失败（${failure?.code ?? 'JUDGMENT_CONTRACT_INVALID'}）。这不是产品缺陷，也不是批准。请恢复判断服务配置或修复输入/输出合同后重新运行；原代码、审查和收据保留，不重复发送同一不可恢复输入。`);
      return;
    }
    state.wait = scheduleJudgmentRetry(state, stage, this.config.daemon.infrastructureRetryBaseMs ?? 60_000,
      this.config.daemon.infrastructureRetryMaxMs ?? 1_800_000);
    const label = stage === 'review' ? 'review-needed' : 'ready-to-merge';
    try {
      await this.transition(state, label, 'waiting');
    } catch (error) {
      if (String((error as { code?: string }).code ?? '').startsWith('FACTORY_STATE_')) throw error;
      state.nextLabel = label;
      state.status = 'waiting';
      await this.store.save(state);
      this.logger.warn(`issue #${state.issue.number} recovery label sync failed: ${String(error)}`);
    }
    this.logger.warn(`issue #${state.issue.number} judgment recovery stage=${stage} attempts=${state.wait.attempts} next=${state.wait.nextAttemptAt}`);
    try {
      await publishTriageDecision(state, `**自动恢复中**\n\n${state.wait.note}`, this.config, this.store);
    } catch (error) {
      if (String((error as { code?: string }).code ?? '').startsWith('FACTORY_STATE_')) throw error;
      this.logger.warn(`issue #${state.issue.number} recovery comment failed: ${String(error)}`);
    }
  }

  private triageNeedsInfoNote(state: FactoryIssueState): string {
    const findings = (state.specReview?.findings ?? [])
      .filter((finding) => finding.severity === 'blocking' || finding.severity === 'important')
      .slice(0, 3).map((finding) => `- ${finding.summary}`).join('\n');
    if (findings) {
      return `规格审查尚有以下阻断项。请在本 issue 逐项说明如何修订，或明确指出你愿意接受哪些非安全风险并要求按现有规格继续：\n${findings}`;
    }
    return '请在本 issue 补充当前缺失的目标行为、适用范围与可验收的预期结果，或明确授权工厂按现有描述自行确定这些细节。收到回复后会重新判断。';
  }

  async runTriage(issue: Issue): Promise<FactoryIssueState> {
    return this.withIssueState(issue, (current, state) => this.runTriageState(current, state));
  }

  private async withIssueState<T>(issue: Issue, run: (current: Issue, state: FactoryIssueState) => Promise<T>,
    reconcileClosed?: (state: FactoryIssueState) => Promise<T>): Promise<T> {
    if (this.store instanceof GitHubIssueStore) {
      return this.store.withLease(issue.number, (state) => run(state.issue, state), issue.number === 0 ? issue : undefined, reconcileClosed);
    }
    const state = await this.store.load(issue.number) ?? { issue, merged: false, attempts: 0, agentMode: 'llm' as const };
    return run(issue, state);
  }

  private async runTriageState(issue: Issue, state: FactoryIssueState): Promise<FactoryIssueState> {
    state.issue = issue;
    state.agentMode = 'llm';
    const result = await this.stage(state, 'triage', async () => {
      const ctx = await this.context(issue, 'triage');
      return this.withProviderSession(state, 'triage', ctx, () =>
        // Spec `2026-09-20-decision-architecture` / Phase B / T9.0:
        // thread the cached triage + freshness hash so a second call
        // within the same `lastJudgmentHash` reuses the cached
        // `TriageResult` instead of paying a fresh typesafe batch.
        // Issue #36 follow-up: also thread the prior triage
        // timestamp so a resumed CLI session gets only NEW comments
        // on incremental polls (M6 incremental principle).
        new TriageAgent(ctx, this.triageCacheFor(state), undefined, state.lastTriageAt, {
          hasSpec: Boolean(state.specs),
          findings: (state.specReview?.findings ?? []).map((finding) => ({
            id: finding.id, severity: finding.severity, summary: finding.summary,
          })),
        }).run());
    });
    // The supervisor path returns a TriageRouting; this method is the
    // readiness gate, so we narrow with a runtime check before reading
    // `state`/`label`.
    if (!('state' in result)) throw new Error('Readiness gate expected a triage decision, got a routing');
    state.triage = result;
    // Stamp the freshly-computed freshness hash so the next poll can
    // hit the cache-reuse branch. The hash is opaque to anything
    // outside `src/core/judgment-state.ts`; storing it on
    // `lastJudgmentHash` (Phase B T8.4 field) keeps the contract
    // additive — older readers simply ignore the field.
    try {
      const fresh = stateHashFor(buildJudgmentState(state.issue));
      state.lastJudgmentHash = fresh;
    } catch {
      // Hashing is pure CPU; failure here means a programmer error
      // in `buildJudgmentState`. Swallow rather than crash the run
      // so the cache-reuse branch never blocks the readiness gate.
    }
    if (state.triage.label === 'wait-to-implement' || state.triage.label === 'needs-info') {
      const note = state.triage.label === 'wait-to-implement'
        ? this.triageWaitNote(state) : this.triageNeedsInfoNote(state);
      state.wait = { reason: 'blocked-operator', note, since: new Date().toISOString() };
      state.triage.comment += `\n\n**需要你的操作**\n\n${note}`;
    }
    await publishTriageDecision(state, state.triage.comment, this.config, this.store);
    await this.transition(state, state.triage.label, 'waiting');
    return state;
  }

  /**
   * Build the `TriageCache` object the agent consumes (Phase B T9.0).
   * The shape is additive — every field is optional — so callers that
   * don't track `lastJudgmentHash` yet still get a valid cache
   * instance. Sourced from the two freshness fields T8.4 added to
   * `FactoryIssueState`: `lastJudgmentHash` (the prior state hash) and
   * `triage` (the cached `TriageResult`). The agent's A1 freshness
   * path compares its freshly-computed hash against `lastJudgmentHash`
   * and reuses `cachedTriage` on a match, so a poll whose state is
   * provably unchanged pays zero typesafe calls.
   */
  private triageCacheFor(state: FactoryIssueState): TriageCache {
    return {
      lastJudgmentHash: state.lastJudgmentHash,
      cachedTriage: state.triage,
    };
  }

  async runForIssue(issue: Issue): Promise<FactoryIssueState> {
    return this.withIssueState(issue, (current, state) => this.runForIssueState(current, state), async (state) => {
      if (await this.confirmMergedImplementation(state)) return state;
      throw new Error('Closed GitHub issues cannot start a pipeline; no matching reviewed and verified merge was found');
    });
  }

  private async confirmMergedImplementation(state: FactoryIssueState): Promise<boolean> {
    const sha = state.implementation?.commitSha;
    const prUrl = state.implementation?.prUrl;
    if (!hasImplementationApproval(state)) return false;
    const prNumber = prUrl && /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl)?.[1];
    if (!prNumber || !this.config.github.token || !this.config.github.repository) return false;
    const remote = await fetchPullRequest({ token: this.config.github.token,
      repository: this.config.github.repository, number: Number(prNumber) });
    if (!canConfirmMergedImplementation(state, remote, this.repo.defaultBranch)) return false;
    const options = { token: this.config.github.token, repository: this.config.github.repository, number: state.issue.number };
    state.merged = true;
    let issue = await fetchIssue(options);
    if (issue.state?.toLowerCase() !== 'closed') {
      state.status = 'waiting';
      await this.store.save(state);
      try {
        await runExternalOp(state, current => this.store.save(current), {
          kind: 'issue-close', idempotencyKey: `${prUrl}:${sha}`, payload: { prUrl, expectedHeadSha: sha },
        }, () => closeIssue(options));
      } catch (error) {
        try { issue = await fetchIssue(options); } catch { /* Unknown until remote observation succeeds. */ }
        if (issue.state?.toLowerCase() !== 'closed') {
          delete state.error;
          await this.waitForOperator(state, 'verified', `PR ${prUrl} 已合并，但 issue 关闭尚未确认。请检查 GitHub 凭据的 issue 写权限及网络，恢复后重新运行本 issue。错误：${String(error)}`);
          return true;
        }
        const op = findExternalOp(state, 'issue-close', `${prUrl}:${sha}`);
        if (op) finishExternalOp(state, { id: op.id, status: 'succeeded', receipt: { state: issue.state } });
        await this.store.save(state);
      }
      issue = await fetchIssue(options);
      if (issue.state?.toLowerCase() !== 'closed') throw new Error('GitHub did not confirm issue closure');
    }
    state.issue.state = 'closed';
    if (!state.merged || state.status !== 'completed' || state.wait || state.error) {
      state.merged = true;
      state.status = 'completed';
      delete state.wait;
      delete state.error;
      await this.store.save(state);
    }
    if (state.nextLabel || state.issue.labels.some((label) => ALL_FACTORY_LABELS.includes(label))) {
      await syncLabel(state, null, this.config, this.store);
    }
    await this.syncProject(state, COMPLETED_PROJECT_STATUS);
    return true;
  }

  private async runForIssueState(issue: Issue, state: FactoryIssueState): Promise<FactoryIssueState> {
    state.issue = issue;
    // Check remote completion before a merged base makes the implementation diff empty.
    if (await this.confirmMergedImplementation(state)) return state;
    if (judgmentRetryPending(state)) return state;
    if (needsJudgmentRecovery(state)) {
      delete state.wait;
      await this.transition(state, state.review?.mergeRoute ? 'ready-to-merge' : 'review-needed');
    }
    // A business-input change or unconsumed human reply can wake the pipeline.
    const inputHash = businessInputHash(issue);
    const replyAnchor = state.lastTriageAt ?? state.wait?.since ?? state.lastFailure?.at;
    const parked = state.status === 'waiting' || state.status === 'failed';
    const changed = (state.lastJudgmentHash !== undefined && state.lastJudgmentHash !== inputHash)
      || ((!parked || Boolean(replyAnchor)) && hasAuthorCommentAfter(issue.comments, replyAnchor));
    state.issue = issue;
    state.agentMode = 'llm';
    if (!state.lastJudgmentHash) {
      state.lastJudgmentHash = inputHash;
      await this.store.save(state);
    }
    if (state.status === 'waiting' && state.nextLabel === 'needs-info' && !changed
        && state.lastFailure && state.wait?.note && !state.wait.note.includes('本次失败详情（')) {
      await this.waitForOperator(state, 'needs-info',
        `${state.wait.note}\n\n本次失败详情（${state.lastFailure.stage}）：\n\n${state.lastFailure.message.slice(0, 6000)}`);
      return state;
    }
    if (state.status === 'waiting' && state.nextLabel === 'needs-info' && changed && state.lastFailure) {
      resetFailedState(state);
      delete state.wait;
      await this.store.save(state);
    }
    if (state.specLoopVersion !== SPEC_LOOP_VERSION) {
      state.specLoopVersion = SPEC_LOOP_VERSION;
      // Older checkpoints carried `specAttempts` capped at 3; the new
      // unified `agentFailures` counter has no per-stage ceiling, so
      // reset the legacy field rather than carrying it forward.
      if (state.specAttempts) state.specAttempts = 0;
    }
    // `changed` is consumed by the routing branches below (see
    // lines around the triage re-evaluation checks).
    if (state.merged) {
      await this.waitForOperator(state, 'verified', 'PR 已记录为合并，但当前规格、验收覆盖或审查 SHA 不满足统一完成条件。请核对已有实现与验收证据；工厂不会重复实施或误报完成。');
      return state;
    }
    if (state.status === 'failed') {
      if (!changed) return state; // Exhausted budgets require genuinely new business input.
      // New business input opens a fresh budget; unchanged failures remain parked.
      const reset = resetFailedState(state);
      this.logger.warn(
        `issue #${issue.number} orchestrator-resetting-failed-state previousError=${(reset.previousError ?? "").slice(0, 200)} nextLabel=${state.nextLabel ?? "null"} reason="let router re-evaluate on fresh attempt"`,
      );
      await this.store.save(state);
    }
    if (state.status === 'simulated') return state;
    if (state.nextLabel && !ALL_FACTORY_LABELS.includes(state.nextLabel as TriageLabel)) {
      delete state.nextLabel;
    }
    if ((issue.labels as string[]).some((label) => RETIRED_FACTORY_LABELS.includes(label as typeof RETIRED_FACTORY_LABELS[number]))) {
      const active = (issue.labels as string[]).find((label) => ALL_FACTORY_LABELS.includes(label as TriageLabel)) as TriageLabel | undefined;
      await syncLabel(state, state.nextLabel ?? active ?? null, this.config, this.store);
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
        await syncLabel(state, winner, this.config, this.store);
        await this.syncProject(state, projectStatusForLabel(winner));
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
      // F-XX (2026-09-17, issue #29): a pending label retry must not
      // swallow the needs-info wake-up evaluated below. A crashed
      // transition left labelPending=true; on resume this branch
      // re-synced the label and the else-if chain never saw the
      // author's new comment, so the issue re-parked without
      // re-triage. Evaluate the same wake condition after the retry.
      if (state.nextLabel === 'needs-info' && changed) {
        delete state.triage;
        state.nextLabel = undefined;
        state.status = undefined;
        forceRetriage = true;
      }
    } else if (state.status === 'waiting' && !state.nextLabel
        && stageForLabel(external[0] ?? '') === 'triage'
        && (changed || external[0])) {
      // Triage stage never ran (or its result was discarded): use the
      // external label as a hint, falling through to the loop below.
      delete state.triage;
      forceRetriage = true;
    } else if (state.status === 'waiting' && state.nextLabel === 'verify-failed'
        && state.implementation?.behaviorVerification
        && (state.implementation.behaviorVerification.status === 'blocked' || state.wait?.reason === 'blocked-operator')) {
      if (state.lastJudgmentHash !== businessInputHash(issue)) {
        delete state.implementation.behaviorVerification;
        delete state.verifiedSha;
        delete state.wait;
        await this.transition(state, 'ready-to-merge');
      } else {
        if (!state.wait?.note) {
          await this.waitForOperator(state, 'verify-failed',
            `实现 PR ${state.implementation.prUrl} 的行为验证被阻断：${state.implementation.behaviorVerification.notes || '未提供详情'}。请解决所述证据、环境或工具问题并在本 issue 回复已恢复。`);
        }
        return state;
      }
    } else if (state.status === 'waiting' && state.nextLabel === 'wait-to-implement'
        && (!state.lastTriageAt || hasAuthorCommentAfter(issue.comments, state.lastTriageAt))) {
      // Legacy checkpoints never stamped lastTriageAt. Re-evaluate them once
      // under the current readiness policy, then wait for a genuinely new
      // author reply instead of parking the old verdict forever.
      delete state.triage;
      state.nextLabel = undefined;
      state.status = undefined;
      forceRetriage = true;
    } else if (state.status === 'waiting' && state.nextLabel === 'needs-info' && changed) {
      // The issue was parked at `needs-info` on the previous pass, but the
      // author has posted a new comment since then. The previous triage
      // decision was made BEFORE this reply was visible, so its verdict
      // is stale. Re-run triage so the new author evidence can flip the
      // outcome (Ready to spec / Ready to implement / keep needs-info
      // with a more specific comment). Issue #24 sat stuck for ~2h
      // because the orchestrator short-circuited on the parked label and
      // the agent never re-evaluated. The daemon's
      // `needs-info-comments-changed-retry` log fires, but without this
      // branch it was cosmetic only — the orchestrator returned without
      // re-dispatching triage.
      delete state.triage;
      state.nextLabel = undefined;
      state.status = undefined;
      forceRetriage = true;
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
        await runGitNetworkCommand(['fetch', 'origin', state.implementation.branch, this.repo.defaultBranch], { cwd: this.repo.workdir });
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
        const dispatchStage = label === 'verify-failed' && hasProductVerificationFailure(state)
          ? 'implementation' : label ? stageForLabel(label) : null;
        if (dispatchStage && ['implementation', 'review', 'verify', 'merge'].includes(dispatchStage)
          && (!state.specs?.commitSha || !state.specs.product.acceptanceCriteria.length)) {
          this.logger.info(`issue #${issue.number} missing acceptance baseline; routing to specification before ${dispatchStage}`);
          label = 'ready-to-spec';
          await this.transition(state, label);
          continue;
        }
        if (dispatchStage && ['implementation', 'review', 'verify', 'merge'].includes(dispatchStage)
          && !hasSpecificationApproval(state)) {
          this.logger.info(`issue #${issue.number} current specification lacks matching approval; routing to specification before ${dispatchStage}`);
          label = 'ready-to-spec';
          await this.transition(state, label);
          continue;
        }
        if (dispatchStage === 'triage') {
          if (label === 'wait-to-implement' && !state.wait?.note) {
            await this.waitForOperator(state, label, this.triageWaitNote(state));
          } else {
            state.status = 'waiting';
            await this.store.save(state);
          }
          return state;
        }
        if (!label) {
          const result = await this.stage(state, 'triage', async () => {
            const ctx = await context('triage');
            return this.withProviderSession(state, 'triage', ctx, () =>
              // Phase B / T9.0: thread the freshness cache so the
              // typesafe batch path can short-circuit on an unchanged
              // hash instead of paying a redundant Jev call.
              // Issue #36 follow-up: also thread the prior triage
              // timestamp so a resumed CLI session gets only NEW
              // comments on incremental polls.
              new TriageAgent(ctx, this.triageCacheFor(state), undefined, state.lastTriageAt, {
                hasSpec: Boolean(state.specs),
                findings: (state.specReview?.findings ?? []).map((finding) => ({
                  id: finding.id, severity: finding.severity, summary: finding.summary,
                })),
              }).run());
          });
          if (!('state' in result)) throw new Error('Readiness gate expected a triage decision, got a routing');
          state.triage = result;
          // Stamp the freshness hash on the persisted checkpoint so
          // the next poll can hit the cache-reuse branch. Mirrors
          // the change in `runTriage`.
          try {
            state.lastJudgmentHash = stateHashFor(buildJudgmentState(state.issue));
          } catch {
            // Hashing is pure CPU; never block the readiness gate on
            // a programmer error in `buildJudgmentState`.
          }
          if (state.triage.label === 'wait-to-implement' || state.triage.label === 'needs-info') {
            const note = state.triage.label === 'wait-to-implement'
              ? this.triageWaitNote(state) : this.triageNeedsInfoNote(state);
            state.wait = { reason: 'blocked-operator', note, since: new Date().toISOString() };
            state.triage.comment += `\n\n**需要你的操作**\n\n${note}`;
          }
          await publishTriageDecision(state, state.triage.comment, this.config, this.store);
          label = state.triage.label;
          await this.transition(state, label, stageForLabel(label) === 'triage' ? 'waiting' : undefined);
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
          if (await fs.lstat(path.join(this.repo.workdir, 'evidence')).catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          })) {
            try {
              const verifications = this.store instanceof GitHubIssueStore ? await this.store.priorVerifications(issue.number)
                : state.implementation?.behaviorVerification ? [state.implementation.behaviorVerification] : [];
              const moved = await relocateLegacyEvidence({ workdir: this.repo.workdir, stateDir: this.config.paths.stateDir,
                repository: `${this.repo.owner}/${this.repo.name}`, issueNumber: issue.number }, verifications.reverse());
              if (moved.length) this.logger.info(`issue #${issue.number} legacy evidence relocated: ${JSON.stringify(moved)}`);
            } catch (error) {
              throw Object.assign(new Error('Factory legacy evidence relocation failed; original or verified external copies are preserved', { cause: error }),
                { code: 'FACTORY_STATE_EVIDENCE_UNAVAILABLE' });
            }
          }
          if (state.specs) {
            // Approved specifications must exist on the base checkout, not just in a lost temporary clone.
            // A fallback ref is available only for a matching approved specification.
            const productPath = `specs/${state.specs.product.slug}/PRODUCT.md`;
            const techPath = `specs/${state.specs.tech.slug}/TECH.md`;
            const defaultRef = `origin/${this.repo.defaultBranch}`;
            try {
              await exec('git', ['cat-file', '-e', `${defaultRef}:${productPath}`], { cwd: this.repo.workdir });
              await exec('git', ['cat-file', '-e', `${defaultRef}:${techPath}`], { cwd: this.repo.workdir });
            } catch (primaryError) {
              const fallbackRef = resolveSpecFallbackRef(state);
              if (!fallbackRef) throw primaryError;
              try {
                await runGitNetworkCommand(['fetch', 'origin', state.specs.specBranch], { cwd: this.repo.workdir }).catch(() => {});
                await exec('git', ['cat-file', '-e', `${fallbackRef}:${productPath}`], { cwd: this.repo.workdir });
                await exec('git', ['cat-file', '-e', `${fallbackRef}:${techPath}`], { cwd: this.repo.workdir });
                this.logger.warn(`issue #${issue.number} approved spec not on ${defaultRef}; using recovery ref ${fallbackRef}`);
              } catch (fallbackError) {
                throw new Error(`Spec files not reachable on ${defaultRef} or ${fallbackRef}: reconcile or re-run spec (primary: ${String(primaryError).slice(0, 200)}; fallback: ${String(fallbackError).slice(0, 200)})`);
              }
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
          state.implementation = await this.stage(state, 'implementation', () =>
            this.withProviderSession(state, 'implementation', ctx, () => new ImplementationAgent(ctx, this.remotePath, state, this.store).run()),
          );
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
          if (!state.review || state.reviewedSha !== sha || state.reviewedBaseSha !== baseSha || !state.review.mergeRoute) {
            const previous = state.review && state.reviewedSha === sha && state.reviewedBaseSha === baseSha
              ? state.review : undefined;
            await this.prepareReviewArtifacts(state);
            state.review = await this.stage(state, 'review', async () => {
              const ctx = await context('review-pr');
              return this.withProviderSession(state, 'review-pr', ctx, () => new ReviewPrAgent(ctx).run(previous));
            });
            state.reviewedSha = sha;
            state.reviewedBaseSha = baseSha;
            if (!previous) {
              delete implementation.behaviorVerification;
              delete state.verifiedSha;
            }
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
              await publishReviewDecision(state, state.review, this.config, this.store);
            } catch (publishError) {
              this.logger.warn(`issue #${issue.number} review publish failed (continuing): ${String(publishError).slice(0, 500)}`);
            }
            if (!state.review.mergeRoute) {
              state.stages!.review.status = 'failed';
              await this.waitForJudgment(state, 'review');
              return state;
            }
            if (state.wait?.reason === 'judgment-retry' && state.wait.stage === 'review') delete state.wait;
            label = state.review.verdict === 'APPROVE' ? 'ready-to-merge' : 'changes-requested';
            await this.transition(state, label);
            continue;
          }
          if (state.review.verdict !== 'APPROVE') {
            label = 'changes-requested';
            await this.transition(state, label);
            continue;
          }
          if (!implementation.behaviorVerification || state.verifiedSha !== sha
            || !hasVerificationJudgment(implementation.behaviorVerification)
            || !hasAcceptanceCoverage(state.specs, sha, implementation.behaviorVerification)) {
            if (!state.specs) throw new Error('Verification requires an approved specification');
            const spec = state.specs;
            await this.assertVerificationCheckout(sha);
            implementation.behaviorVerification = await this.stage(state, 'verify', async () => {
              const ctx = await context('verify-behavior', undefined, state.correction);
              return this.withProviderSession(state, 'verify-behavior', ctx, async () => {
                const agent = new VerifyBehaviorAgent(ctx, 'verify', { spec, implementationSha: sha });
                const previous = implementation.behaviorVerification;
                // A missing service judgment does not invalidate observed passing execution.
                // A negative judgment does: those assertions must be redesigned and rerun.
                if (previous && !previous.judgment) {
                  const recovered = await agent.rejudge(previous);
                  if (recovered) return recovered;
                }
                return agent.run();
              });
            });
            await this.assertVerificationCheckout(sha);
            const verified = implementation.behaviorVerification.status === 'verified'
              && hasVerificationJudgment(implementation.behaviorVerification)
              && hasAcceptanceCoverage(state.specs, sha, implementation.behaviorVerification);
            state.stages!.verify.status = verified ? 'completed' : 'failed';
            await this.store.save(state);
            if (verified) state.verifiedSha = sha;
            else delete state.verifiedSha;
            if (implementation.behaviorVerification.judgmentFailure) {
              await this.waitForJudgment(state, 'verify');
              return state;
            }
            if (state.wait?.reason === 'judgment-retry' && state.wait.stage === 'verify') delete state.wait;
            label = verified ? 'verified' : 'verify-failed';
            if (verified) {
              delete state.verificationRecovery;
              if (state.correction?.targetStage === 'verify-behavior') delete state.correction;
            } else if (!hasProductVerificationFailure(state)) {
              const recoveryInput = businessInputHash({ ...issue, labels: issue.labels.filter(label => !ALL_FACTORY_LABELS.includes(label)) });
              const recovery = advanceVerificationRecovery(state, recoveryInput, DEFAULT_FAILURE_POLICY.CONTRACT_VIOLATION.maxAttempts);
              const detail = implementation.behaviorVerification.failure?.reason || implementation.behaviorVerification.notes || '未提供具体证据';
              this.logger.info(`issue #${issue.number} verification recovery=${recovery} owner=${implementation.behaviorVerification.failure?.kind ?? 'evidence'} attempts=${state.verificationRecovery!.attempts}`);
              if (recovery === 'park') {
                await this.waitForOperator(state, label,
                  `实现 PR ${implementation.prUrl} 的行为验收没有证明产品缺陷或全部 AC 通过。责任域：${implementation.behaviorVerification.failure?.kind ?? 'evidence'}。当前上下文及有效 AC 进度下已尝试 ${state.verificationRecovery!.attempts} 次，仍未形成完整证据，保留实现、审查和失败历史，不重写产品。\n\n具体原因：${detail.slice(0, 6000)}\n\n需要你的操作：根据上述原因修复验收工具/环境，或补充与批准 AC 相符的断言依据，并在本 issue 回复具体恢复信息；工厂将重新验收，不把该回复当作批准或通过。`);
                return state;
              }
              state.correction = { targetStage: 'verify-behavior', turns: [
                `Previous verification lacked sufficient evidence. Reuse implementation ${sha}; do not modify product code.`,
                detail.slice(0, 6000), 'Rerun the affected assertions with correct cwd, selectors and expected values; register exact current-run receipts for every AC.',
              ] };
              label = 'ready-to-merge';
            }
            await this.transition(state, label);
            continue;
          }
          if (implementation.behaviorVerification.status !== 'verified') {
            label = 'verify-failed';
            await this.transition(state, label);
            continue;
          }
          if (!this.config.autoMerge && implementation.prUrl && this.config.github.token && this.config.github.repository) {
            if (await this.confirmMergedImplementation(state)) return state;
          }
          if (!this.config.autoMerge) {
            await this.waitForOperator(state, 'verified', `实现 PR ${implementation.prUrl} 已通过审查与行为验证。当前 autoMerge=false，请人工检查并合并该 PR；合并前工厂不会把 issue 标记为完成。`);
            return state;
          }
          if (state.review.mergeRoute?.mode !== 'auto') {
            this.logger.warn(`issue #${issue.number} merge requires review-pr auto route; route=${state.review.mergeRoute?.mode ?? 'unavailable'}`);
            await this.waitForOperator(state, 'verified', `实现 PR ${implementation.prUrl} 已通过行为验证，但审查合并路由为 ${state.review.mergeRoute?.mode ?? 'unavailable'}，不允许自动合并。请人工复核 PR，并在本 issue 回复批准合并或需要修改的具体项。`);
            return state;
          }
          await this.stage(state, 'merge', () => runExternalOp(state, (current) => this.store.save(current), {
            kind: 'pr-merge', idempotencyKey: implementation.prUrl, payload: { prUrl: implementation.prUrl, expectedHeadSha: sha },
          }, () => mergePullRequest({ workdir: this.repo.workdir, remotePath: this.remotePath, prUrl: implementation.prUrl, expectedHeadSha: sha })));
          if (!await this.confirmMergedImplementation(state)) throw new Error('Merged PR does not satisfy the completion contract');
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
      if (String((error as { code?: string }).code ?? '').startsWith('FACTORY_STATE_')) throw error;
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
    // M5: classify the error BEFORE paying the supervisor LLM
    // token cost. The classifier picks a fast-path action for
    // obvious cases (POLICY_BLOCK → needs-info; PERMANENT →
    // abort; same-class N-times → escalate) so the supervisor is
    // only consulted for genuinely ambiguous failures. The
    // spec-review dead loop on issue #29 was kept alive because
    // the supervisor kept choosing `retry spec` for the same root
    // cause; the per-(stage, class) counter now escalates after
    // 3 repeats regardless of what the LLM "thinks".
    const category = classifyError(error);
    const classified = { ...category, ...DEFAULT_FAILURE_POLICY[category.class] };
    const total = bumpFailureCount(state, lastStage ?? 'unknown', classified.class);
    state.lastFailure = {
      stage: lastStage ?? 'unknown',
      class: classified.class,
      message: error.message,
      at: new Date().toISOString(),
    };
    appendEvent(state, {
      stage: lastStage ?? 'orchestrator',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'failed',
      reason: `[failure-classifier] ${classified.class} (${classified.reason}); counter=${total}/${classified.maxAttempts}`,
    });
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
    // Deterministic routing — replaces the LLM `triage-supervisor`
    // stage. See `src/core/routing-decision.ts`.
    const routing = decideRouting(
      classified,
      failure,
      (state.failureCounts ?? {}) as Record<string, Record<typeof classified.class, number>>,
      lastStage,
      { nextLabel: state.nextLabel, correction: state.correction },
    );

    appendEvent(state, {
      stage: 'orchestrator',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'self-healed',
      attempts: state.attempts,
      reason: `[router] ${routing.action} → ${routing.targetStage || 'n/a'} — ${routing.comment}`,
    });

    // Apply routing. Every action resets enough state that the next
    // loop iteration lands on a clean dispatch for the chosen target.
    if (routing.action === 'retry') {
      const target = routing.targetStage || lastStage || 'implementation';
      state.correction = { targetStage: target, turns: routing.correction ?? [] };
      setNextLabelForStage(state, target);
      delete state.error;
      await this.store.save(state);
      // F-XX (2026-09-15): syncLabel after the retry routing so the GitHub
      // issue label tracks checkpoint.nextLabel. Previously the retry branch
      // only persisted `state` and returned, leaving the issue label in its
      // pre-routing state. The next daemon tick's `factoryLabels[0] ===
      // checkpoint.nextLabel` skip-check would then never match, so on the
      // rare tick that DID see the issue (post-network-recovery) it would
      // bounce back into the pipeline with the wrong nextLabel guess. A
      // transient syncLabel failure must not block the retry — the checkpoint
      // is already durable and the next tick will retry the label too.
      try {
        await syncLabel(state, state.nextLabel ?? null, this.config, this.store);
      } catch (syncError) {
        this.logger.warn(
          `issue #${issue.number} retry label-sync failed (${(syncError as Error).message ?? String(syncError)}); next tick will retry`,
        );
      }
      return;
    }
    if (routing.action === 'reroute') {
      const target = routing.targetStage;
      // Spec plan §3.4: "reroute 按目标阶段保留修订所需产物与反馈, 只使受影响的下游结果失效".
      // The previous implementation wiped every stage-specific field,
      // which deleted the supervisor's `correction` and any prior spec
      // outputs — so a reroute to spec/review-spec lost exactly the
      // feedback the next attempt needed (F02). We clear only the
      // fields invalidated by rerouting past a stage that produced
      // them.
      const preserved = reroutePreservedFields(target);
      clearRerouteInvalidatedFields(state, target);
      appendEvent(state, {
        stage: target || 'reroute',
        startedAt: new Date().toISOString(),
        status: 'completed',
        reason: `rerouted to ${target}`,
        ...(preserved.length > 0 ? { verdict: `preserved:${preserved.join(',')}` } : {}),
      });
      setNextLabelForStage(state, target ?? lastStage ?? 'spec');
      await syncLabel(state, null, this.config, this.store);
      delete state.error;
      await this.store.save(state);
      return;
    }
    if (routing.action === 'needs-info') {
      delete state.correction;
      await this.waitForOperator(state, 'needs-info',
        `${routing.comment || classified.reason}\n\n请在本 issue 回复如何解决上述具体阻断项，或修复环境后回复“已恢复”；工厂会在新回复后重新判断。`);
      return;
    }
    // abort — surface as a hard failure with the router's reason.
    state.status = 'failed';
    state.error = routing.comment || `Routing aborted: ${error.message}`;
    delete state.correction;
    await this.store.save(state);
    await publishTriageDecision(state,
      `**需要你的操作**\n\n${state.error}\n\n请检查并修复该失败原因，然后在本 issue 回复已恢复。`,
      this.config, this.store).catch((publishError) =>
        this.logger.warn(`issue #${issue.number} abort comment failed: ${String(publishError)}`));
    throw new Error(state.error);
  }

  private async prepareReviewArtifacts(state: FactoryIssueState) {
    await prepareReviewArtifacts(state, this.repo, this.reviewDirFor(state.issue.number));
  }

  private async prepareSpecReviewArtifacts(state: FactoryIssueState, specCommitSha: string, specPrUrl: string): Promise<void> {
    await prepareSpecReviewArtifacts(state, specCommitSha, specPrUrl, this.repo, this.reviewDirFor(state.issue.number));
  }

  private async runSpecPhase(state: FactoryIssueState, issue: Issue, context: (name: string, runIdOverride?: string, correction?: AgentContext['correction']) => Promise<AgentContext>): Promise<void> {
    await runSpecPhaseBody({
      repo: this.repo,
      remotePath: this.remotePath,
      config: this.config,
      logger: this.logger,
      store: this.store,
      stage: (state, name, run) => this.stage(state, name, run),
      withProviderSession: (state, role, ctx, run) => this.withProviderSession(state, role, ctx, run),
      prepareSpecReviewArtifacts: (state, sha, url) => this.prepareSpecReviewArtifacts(state, sha, url),
      transition: (state, label, status) => this.transition(state, label, status),
    }, state, issue, context);
  }

  private async syncProject(state: FactoryIssueState, status: ProjectStatus): Promise<void> {
    const issue = state.issue;
    if (!this.config.syncProjects) return;
    const token = this.config.github.token;
    const repo = this.config.github.repository || `${this.repo.owner}/${this.repo.name}`;
    if (!token || !repo) return;
    try {
      const result = await runExternalOp(state, (current) => this.store.save(current), {
        kind: 'project-sync', idempotencyKey: `${issue.number}@${status}`, payload: { status },
      }, () => syncIssueProjectStatus({ repo, issueNumber: issue.number, status, token }));
      if (result.projectsFound > 0) {
        this.logger.info(`issue #${issue.number} project status=${status} projects=${result.projectsFound} added=${result.itemsAdded} updated=${result.itemsUpdated}`);
      }
      for (const warning of result.warnings) this.logger.warn(`issue #${issue.number} project sync: ${warning}`);
    } catch (error) {
      this.logger.warn(`issue #${issue.number} project sync failed for status=${status}: ${String(error)}`);
    }
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
    return this.withIssueState(issue, async (current, state) => {
      const ctx = await this.context(current, 'verify-behavior');
      const acceptance = mode === 'verify' && state.specs && state.implementation?.commitSha
        ? { spec: state.specs, implementationSha: state.implementation.commitSha } : undefined;
      if (mode === 'verify' && !acceptance) throw new Error('Verification requires the specification and implementation SHA');
      if (acceptance) await this.assertVerificationCheckout(acceptance.implementationSha);
      const result = await this.stage(state, 'verify-behavior', () =>
        this.withProviderSession(state, 'verify-behavior', ctx, () => new VerifyBehaviorAgent(ctx, mode, acceptance).run()));
      if (acceptance) await this.assertVerificationCheckout(acceptance.implementationSha);
      if (state.implementation) state.implementation.behaviorVerification = result;
      if (acceptance && result.status === 'verified' && hasAcceptanceCoverage(state.specs, acceptance.implementationSha, result)) state.verifiedSha = acceptance.implementationSha;
      else if (mode === 'verify') delete state.verifiedSha;
      await this.store.save(state);
      return result;
    });
  }

  async runReviewPr(issue: Issue) {
    const reviewDir = this.reviewDirFor(issue.number);
    const diff = await fs.readFile(path.join(reviewDir, 'pr_diff.txt'), 'utf8');
    if (!diff.trim()) throw new Error('Review stage requires a non-empty annotated pr_diff.txt');
    return this.withIssueState(issue, async (current, state) => {
      const ctx = await this.context(current, 'review-pr');
      const result = await this.stage(state, 'review-pr', () =>
        this.withProviderSession(state, 'review-pr', ctx, () => new ReviewPrAgent(ctx).run()));
      state.review = result;
      await this.store.save(state);
      return result;
    });
  }

  async runImproveReviewPr(issue: Issue) {
    return this.withIssueState(issue, async (current, state) => {
      const ctx = await this.context(current, 'improve-review-pr');
      const skillBody = (await this.loader.load('review-pr')).body;
      try {
        return await this.withProviderSession(state, 'improve-review-pr', ctx, () =>
          new ImproveReviewPrAgent(ctx, this.remotePath, skillBody).run());
      } finally {
        if (current.number !== 0 || this.store instanceof GitHubIssueStore) await this.store.save(state);
      }
    });
  }

  async triggerByLabel(issue: Issue, label: TriageLabel) {
    return this.runForIssue({ ...issue, labels: [label] });
  }

  /** Checkpoints are persisted at each transition, not only on successful CLI exit. */
  async persist(): Promise<void> {}
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

/**
 * M5: capture the artifact the just-completed stage produced.
 *
 * Called from the `stage()` wrapper right before the next
 * `store.save()`. The wrapper used to throw away the artifact body
 * after writing it to the field; the tracker now records a content
 * hash + parentRevision so a recovery tool can answer "what did the
 * spec say at revision N?" without re-running any agent.
 *
 * Best-effort: a tracker failure returns the input array unchanged
 * so the save still goes through. The existing
 * `assertSpecFilesMatchBodies` path remains the only hard guard
 * on spec bodies.
 */
function recordStageArtifacts(
  state: FactoryIssueState,
  name: string,
  runId: string,
  result: unknown,
): import('../core/types.js').ArtifactRevision[] {
  const existing = state.artifacts ?? [];
  try {
    if (name === 'spec' && result && typeof result === 'object' && 'product' in result) {
      return recordSpecArtifacts(state, result as import('../core/types.js').SpecPair, name, runId);
    }
    if (name === 'review-spec' && result && typeof result === 'object' && 'verdict' in result) {
      return recordSpecReviewArtifact(state, result as import('../core/types.js').SpecReviewResult, name, runId);
    }
    if (name === 'implementation' && result && typeof result === 'object' && 'commitSha' in result) {
      return recordImplementationArtifacts(state, result as import('../core/types.js').ImplementationResult, name, runId);
    }
    if (name === 'review' && result && typeof result === 'object' && 'verdict' in result && 'body' in result) {
      return recordReviewPrArtifact(state, result as import('../core/types.js').ReviewResult, name, runId);
    }
    if (name === 'verify-behavior' && result && typeof result === 'object') {
      return recordVerifyEvidenceArtifact(state, result as import('../core/types.js').BehaviorVerificationResult, name, runId);
    }
  } catch {
    // Tracker is best-effort; never block a save.
    return existing;
  }
  return existing;
}
