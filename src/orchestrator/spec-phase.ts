import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reviewRejectionDetail } from './learning.js';
import type { AgentContext, FactoryIssueState, Issue, ProductSpec, SpecRubricBatchAnswer } from '../core/types.js';
import type { FactoryConfig } from '../../runtime/factory-config.mjs';
import type { IssueStateStore } from '../core/state.js';
import { runExternalOp } from '../core/external-op-ledger.js';
import { deriveSpecVerdict, deriveReviewVerdict, resolveExploreBlockFloor } from '../core/spec-verdict.js';
import { deriveRubricVerdict, synthesizeRubricReview, updateRubricFailureCounts } from '../core/spec-review-rubric.js';
import { runReviewRubricBatch } from '../agents/spec-review-rubric.js';
import { commitAndPushTool, openPullRequestTool } from '../core/tools.js';
import { SpecAgent, specBodiesChanged } from '../agents/spec.js';
import { ReviewSpecAgent } from '../agents/review-spec.js';
import { mergePullRequest, runGitNetworkCommand } from '../github/git.js';
import { publishSpecReviewDecision } from './decision-publish.js';
import { hasSpecificationApproval } from './spec-fallback.js';

const exec = promisify(execFile);

export interface SpecPhaseDependencies {
  repo: AgentContext['repo'];
  remotePath: string;
  config: FactoryConfig;
  logger: AgentContext['logger'];
  store: Pick<IssueStateStore, 'save'>;
  stage<T>(state: FactoryIssueState, name: string, run: (runId: string) => Promise<T>): Promise<T>;
  withProviderSession<T>(state: FactoryIssueState, role: string, ctx: AgentContext, run: () => Promise<T>): Promise<T>;
  prepareSpecReviewArtifacts(state: FactoryIssueState, sha: string, url: string): Promise<void>;
  transition(state: FactoryIssueState, label: import('../core/types.js').TriageLabel, status?: FactoryIssueState['status']): Promise<void>;
  /** Failure-driven learning (core/lessons.ts); optional so isolated callers can omit it. */
  learn?(state: FactoryIssueState, role: string, stage: string, kind: string, detail: string): Promise<void>;
  creditLessons?(state: FactoryIssueState, ...roles: string[]): Promise<void>;
}

/**
   * Run SpecAgent + ReviewSpecAgent in a self-resolving loop. The loop
   * terminates when ReviewSpecAgent returns APPROVE — at that point the
   * spec PR is auto-merged into base, the issue transitions to
   * `ready-to-implement`, and the caller's for(;;) picks up the next
   * stage on the next iteration.
   *
   * Rejections and unchanged drafts stay in this repair loop without
   * a revision-count ceiling. Execution failures still reach the
   * outer failure handler. Review quality gates remain mandatory.
   */
  export async function runSpecPhaseBody(deps: SpecPhaseDependencies, state: FactoryIssueState, issue: Issue, context: (name: string, runIdOverride?: string, correction?: AgentContext['correction']) => Promise<AgentContext>): Promise<void> {
    if (hasSpecificationApproval(state) && (
      state.nextLabel === 'merging-spec' || state.nextLabel === 'reviewing-spec'
      || state.correction?.targetStage === 'merge-spec-pr'
      || (state.wait?.reason === 'runtime-retry' && state.stages?.['merge-spec-pr']?.status === 'interrupted')
    )) {
      deps.logger.info(`issue #${issue.number} resuming approved specification merge commit=${state.specs!.commitSha}`);
      await mergeApprovedSpecification(deps, state);
      return;
    }
    let resumingReview = state.agentRuntimeFailure?.stage === 'review-spec'
      && Boolean(state.specs?.commitSha && state.specs.specPrUrl
        && state.specs.revisions?.at(-1)?.commitSha === state.specs.commitSha);
    // Worktree hygiene + clean base (issue #29, 2026-09-17): the spec
    // branch is ALWAYS re-cut from origin/<default> and the worktree
    // must be pristine before the spec agent writes. Two production
    // failures motivated this:
    //   - implementation-attempt debris (uncommitted template/** edits,
    //     plus stale local spec commits sitting in the worktree HEAD)
    //     was swept into the spec PR — shipping a non-building
    //     main.tsx and duplicated spec directories;
    //   - the old REJECT re-base onto origin/<specBranch> preserved
    //     that polluted history, so scoped commits on top could never
    //     clean the PR diff.
    // reset --hard + clean only discard UNCOMMITTED debris (commits are
    // never destroyed; uncommitted == not done by factory design). The
    // DETACH avoids needing the agent-chosen spec branch name up front
    // — commitAndPush re-points the branch at this exact HEAD later,
    // and the push uses --force-with-lease because a REJECT revision
    // legitimately rewrites the factory-owned spec branch.
    await exec('git', ['reset', '--hard', 'HEAD'], { cwd: deps.repo.workdir }).catch(() => {});
    await exec('git', [
      'clean', '-fd',
      '--exclude=factory', '--exclude=node_modules', '--exclude=evidence',
      '--exclude=dist', '--exclude=build', '--exclude=coverage',
      '--exclude=*.tsbuildinfo', '--exclude=.DS_Store',
      '--',
    ], { cwd: deps.repo.workdir }).catch(() => {});
    await runGitNetworkCommand(['fetch', 'origin', deps.repo.defaultBranch], { cwd: deps.repo.workdir });
    if (resumingReview) {
      await runGitNetworkCommand(['fetch','origin',state.specs!.specBranch],{cwd:deps.repo.workdir});
      const head = (await exec('git',['rev-parse','FETCH_HEAD'],{cwd:deps.repo.workdir})).stdout.trim();
      if (head !== state.specs!.commitSha) throw Object.assign(new Error('Published specification changed before review recovery'),{code:'FACTORY_STATE_SPEC_REVISION_CHANGED'});
      deps.logger.info(`issue #${issue.number} resuming specification review commit=${head}; generation and publication reused`);
    }
    await exec('git', ['checkout', '--detach', resumingReview ? state.specs!.commitSha! : `origin/${deps.repo.defaultBranch}`], { cwd: deps.repo.workdir });
    let fixedProduct: ProductSpec | undefined;
    for (;;) {
      const publishedSpec = resumingReview ? state.specs : undefined;
      resumingReview = false;
      // P2 (2026-09-18): when state.specs is null but the previous
      // run produced a spec, the artifacts[] array still carries
      // the body (see `recordSpecArtifacts`). Recover the previous
      // product / tech bodies from disk so the spec agent can
      // amend rather than re-derive. This is the safety net for
      // any future bug that wipes state.specs.
      let previousSpecs = state.specs;
      if (!previousSpecs) {
        const recovered = await recoverPreviousSpecFromArtifacts(deps.repo.workdir, state.artifacts);
        if (recovered) {
          deps.logger.info(`issue #${issue.number} recovered previous spec body from artifacts[] (state.specs was null)`);
          previousSpecs = recovered;
        }
      }
      // M5: bind this revision to a stable id + the previous commit
      // sha + the structured findings array. The previous commit
      // sha + verdict let the spec agent fetch the prior diff when
      // it needs to know what changed; the findings array is the
      // primary revision signal (replaces the issue-comment regex
      // parsing that previously let the spec-review dead loop slide
      // through every retry without the agent seeing what was
      // rejected).
      const revisionId = state.specReview?.verdict === 'REJECT' ? randomUUID() : undefined;
      const previousSpecRevision = state.specs?.revisions?.at(-1);
      // R-series rubric (issue #39 convergence fix): capture the prior
      // review round's findings BEFORE this round overwrites
      // `state.specReview`. They are the R7 resolution-check input —
      // each previous finding becomes a structured "is it resolved in
      // the revised spec?" judgment point, which is what makes
      // convergence measurable per point instead of a de-novo re-scan.
      const previousRoundFindings = state.specReview?.verdict === 'REJECT'
        ? (state.specReview.findings ?? [])
        : undefined;
      const revision = state.specReview?.verdict === 'REJECT' && previousSpecs
        ? {
            feedback: buildSpecFeedback(state),
            previousProductBody: previousSpecs.product.body,
            previousTechBody: previousSpecs.tech.body,
            previousCommitSha: previousSpecRevision?.commitSha ?? previousSpecs.commitSha,
            previousVerdict: 'REJECT' as const,
            specReviewFindings: state.specReview.findings ?? [],
            revisionId,
            fixedProduct: fixedProduct ?? (previousRoundFindings?.length && previousRoundFindings.every(finding =>
              finding.evidence?.path?.endsWith('/TECH.md')) ? previousSpecs.product : undefined),
          }
        : undefined;
      const nextSpecs = publishedSpec ?? await deps.stage(state, 'spec', async runId => {
        const specCtx = await context('spec', runId, state.correction);
        return deps.withProviderSession(state, 'spec', specCtx, () => new SpecAgent(specCtx, revision).run());
      });
      if (!publishedSpec && revision && previousSpecs && !specBodiesChanged(previousSpecs, nextSpecs)) {
        deps.logger.warn(`issue #${issue.number} spec revision unchanged; retrying the unresolved findings without publication`);
        state.correction = { targetStage: 'spec', turns: [
          'The last revision changed neither document. Edit the exact text cited by each unresolved finding; verify the replacement against repository files and dependency APIs before returning.',
        ] };
        await deps.store.save(state);
        continue;
      }
      // --- typesafe veto gate (issue #36 root cause fix) ---
      // Specs produced via the `claude-code` path can carry defects the
      // structured-output parser didn't catch: e.g. duplicate spec
      // trees, contradiction between PRODUCT.md and TECH.md acceptance
      // gates, unverifiable acceptance criteria. The typesafe batch's
      // B1/B2/B3 answers surface these. When they do, we run the spec
      // phase revision loop *without* committing/pushing the bad spec —
      // the orchestrator's retry path doesn't need to wait for the
      // expensive LLM supervisor to discover the same defect.
      const specVerdict = deriveSpecVerdict(nextSpecs, nextSpecs.typesafeBatch);
      if (specVerdict.verdict === 'needs-revision') {
        state.specTypesafeRevisions = (state.specTypesafeRevisions ?? 0) + 1;
        state.lastSpecVerdict = {
          verdict: 'needs-revision',
          reasons: specVerdict.reasons,
        };
        deps.logger.warn(
          `issue #${issue.number} spec-typesafe-revision ${state.specTypesafeRevisions} reasons=${JSON.stringify(specVerdict.reasons)} target=${specVerdict.targetStage ?? 'unknown'}`,
        );
        // Synthesise a `REJECT` review so the next iteration's
        // `revision` builder at line 1441 picks up the typesafe reasons
        // as feedback for the spec agent. We deliberately do NOT commit
        // or push — the spec agent will write a fresh PRODUCT.md /
        // TECH.md on the next iteration that addresses the reasons.
        const now = new Date().toISOString();
        state.specReview = {
          verdict: 'REJECT',
          body: `typesafe veto:\n\n${specVerdict.reasons.map((r) => `- ${r}`).join('\n')}`,
          comments: [],
          notes: '',
          findings: specVerdict.reasons.map((reason, idx) => ({
            id: `TYPESAFE-${idx + 1}`,
            ruleId: 'typesafe-veto',
            severity: 'blocking' as const,
            summary: reason,
            requirementIds: [],
            evidence: {},
            sourceStage: 'spec',
            sourceRunId: state.stages?.['spec']?.runId ?? '',
            registeredAt: now,
            status: 'open' as const,
          })),
        };
        nextSpecs.revisions = previousSpecs?.revisions;
        state.specs = nextSpecs;
        fixedProduct = specVerdict.targetStage === 'spec-tech' ? nextSpecs.product : undefined;
        await deps.store.save(state);
        continue;
      }
      fixedProduct = undefined;
      state.lastSpecVerdict = { verdict: 'pass', reasons: specVerdict.reasons };
      state.specs = nextSpecs;
      const spec = state.specs;
      // The spec agent has write_file in its tool list (see SpecAgent
      // tools), so it writes PRODUCT.md / TECH.md directly to the
      // worktree. We trust the agent's output here: commit the
      // resulting files (whatever they are) rather than re-writing
      // them from the structured body, which would race with the
      // agent and lose any user-driven edits the agent made to the
      // file (e.g. alignment, whitespace, tool-applied formatting).
      const specCtxForCommit = await context('spec', state.stages?.spec?.runId);
      let thisRevisionId = spec.revisions?.at(-1)?.id ?? randomUUID();
      if (!publishedSpec) {
        // Scope the spec commit to specs/ — a spec PR must contain ONLY
        // spec changes. Issue #29: implementation-attempt debris left in
        // the worktree (template/** edits importing files that don't
        // exist yet) was swept in by the unscoped `git add -A`, shipping
        // a non-building main.tsx inside the spec PR — correctly
        // REJECTed by review-spec as a contract violation.
        const commit = await runExternalOp(state, (current) => deps.store.save(current), {
          kind: 'spec-push', idempotencyKey: `${issue.number}@${spec.specBranch}`, payload: { branch: spec.specBranch },
        }, id => commitAndPushTool(specCtxForCommit, async commitSha => {
          state.externalOps!.find(entry => entry.id === id)!.expectedRemote = { commitSha };
          await deps.store.save(state);
        }).execute({ branch: spec.specBranch, message: `Specify issue #${issue.number}`, files: ['specs/'], force: true }, specCtxForCommit)) as { ok: boolean; commitSha: string };
        if (!commit.ok) throw new Error('Specification publication failed');
        const pr = await runExternalOp(state, (current) => deps.store.save(current), {
          kind: 'pr-create', idempotencyKey: `${issue.number}@${spec.specBranch}`, payload: { branch: spec.specBranch },
          expectedRemote: { headSha: commit.commitSha, baseBranch: deps.repo.defaultBranch },
        }, () => openPullRequestTool(specCtxForCommit, deps.remotePath).execute({ branch: spec.specBranch, title: `Spec: ${issue.title}`, body: `Specifications for #${issue.number}. Auto-reviewed by the factory and merged once approved.`, baseBranch: deps.repo.defaultBranch }, specCtxForCommit)) as { prUrl: string; headSha: string };
        if (!pr.prUrl || pr.headSha !== commit.commitSha) throw new Error('Specification PR not confirmed');
        spec.specPrUrl = pr.prUrl;
        spec.commitSha = commit.commitSha;
        // M5: bind this revision to a stable id and remember it for
        // the next iteration. `revisionId` was generated when we
        // decided this was a REJECT-driven revision; on the first
        // pass (no prior spec) we mint a fresh id.
        thisRevisionId = revisionId ?? randomUUID();
        spec.revisions = [
          ...(previousSpecs?.revisions ?? []),
          {
            id: thisRevisionId,
            commitSha: commit.commitSha,
            runId: state.stages?.['spec']?.runId ?? '',
            generatedAt: new Date().toISOString(),
            amended: Boolean(previousSpecRevision),
            commitShort: commit.commitSha.slice(0, 8),
          },
        ];
        }
      const commit = { commitSha: spec.commitSha! };
      const pr = { prUrl: spec.specPrUrl };
      // ReviewSpecAgent. Cache by specBranch + commitSha so a re-run
      // with the same spec reuses the prior verdict (mirrors the
      // implementation-phase review cache at :183-193). The
      // revisionId guard inside the cache check is a defensive
      // backstop: if the spec re-generates to a body the agent
      // declares "no material change" (so commitSha stays the same
      // as the previous revision) we still re-run review-spec so
      // the reviewer can issue a fresh verdict for the new
      // revisionId.
      const reviewKey = `${spec.specBranch}@${commit.commitSha}`;
      const reviewIsForCurrentRevision = state.specReview?.revisionId === thisRevisionId;
      if (!state.specReview || state.specReviewedKey !== reviewKey || !reviewIsForCurrentRevision) {
        await deps.prepareSpecReviewArtifacts(state, commit.commitSha, pr.prUrl);
        // --- R-series rubric gate (issue #39 convergence fix) ---
        // Structured Jev judgment points over the parsed spec fields
        // run INSIDE the review-spec stage, before the LLM pass:
        //   - rubric REJECT → publish findings and revise in this phase;
        //     the LLM review is skipped entirely for this round.
        //   - consecutive failures remain audit counters, never a human dependency;
        //   - rubric pass / unavailable → the LLM exploration review
        //     proceeds; B5 promotions require located evidence and confidence.
        let rubricPassBatch: SpecRubricBatchAnswer | undefined;
        state.specReview = await deps.stage(state, 'review-spec', async runId => {
          const reviewCtx = await context('review-spec', runId, state.correction);
          return deps.withProviderSession(state, 'review-spec', reviewCtx, async () => {
          const rubricGate = await runReviewRubricBatch(issue, spec, previousRoundFindings, deps.logger, reviewCtx);
          if (rubricGate) {
            const rubricVerdict = deriveRubricVerdict(rubricGate.answer, rubricGate.input);
            const ratchet = updateRubricFailureCounts(state.specRubricFailures, rubricVerdict.failedPoints);
            state.specRubricFailures = ratchet.counts;
            if (rubricVerdict.verdict === 'reject') {
              deps.logger.warn(
                `issue #${issue.number} spec review REJECTED by R-series rubric (${rubricVerdict.findings.length} finding(s): ${rubricVerdict.failedPoints.join(', ')}) — LLM review pass skipped`,
              );
              return synthesizeRubricReview(
                rubricVerdict,
                rubricGate.answer,
                state.stages?.['review-spec']?.runId ?? 'review-spec',
                thisRevisionId,
              );
            }
            // Rubric pass — keep the batch to attach to the LLM review
            // result for observability (panel + audit trail).
            rubricPassBatch = rubricGate.answer;
          }
          return new ReviewSpecAgent(reviewCtx, undefined, previousRoundFindings).run();
          });
        });
        state.specReview.revisionId = thisRevisionId;
        state.specReviewedKey = reviewKey;
        if (rubricPassBatch && !state.specReview.rubricBatch) {
          state.specReview.rubricBatch = rubricPassBatch;
        }
        // --- typesafe verdict gate for review-spec ---
        // B4 checks consistency; only current, concrete findings can
        // veto the reviewer. Preserve the original verdict for audit.
        state.specReview.reviewerVerdict ??= state.specReview.verdict;
        // B5 promotions need located evidence and sufficient confidence.
        // Existing reviewer blockers remain until a new review resolves them.
        const reviewVerdict = deriveReviewVerdict(state.specReview, state.specReview.typesafeBatch, {
          requireBlockingEvidence: true,
          exploreBlockFloor: resolveExploreBlockFloor(process.env) ?? 0,
        });
        deps.logger.info(`issue #${issue.number} spec-review-gate ${JSON.stringify({
          snapshot: state.specReview.inputRevision,
          reviewer: state.specReview.reviewerVerdict,
          jev: state.specReview.typesafeBatch?.b4,
          final: reviewVerdict.verdict,
          reasons: reviewVerdict.reasons,
        })}`);
        if (reviewVerdict.verdict !== state.specReview.verdict) {
          deps.logger.warn(
            `issue #${issue.number} review-typesafe-verdict override verdict=${reviewVerdict.verdict} (was ${state.specReview.verdict}) reasons=${JSON.stringify(reviewVerdict.reasons)}`,
          );
          state.specReview.verdict = reviewVerdict.verdict;
        }
        // Apply per-finding severity overrides.
        if (reviewVerdict.severityOverrides.size > 0) {
          for (const finding of state.specReview.findings ?? []) {
            const override = reviewVerdict.severityOverrides.get(finding.id);
            if (override) {
              finding.severity = override;
            }
          }
        }
        // Append reasons to `notes` so audit trail survives — never to
        // `body`, which the spec-revision parser keys on for finding
        // markers and would mistakenly pick up our audit lines as
        // findings.
        //
        // Skip the placeholder single-element `typesafe-unavailable`
        // reason: when typesafe is off / missing, `deriveReviewVerdict`
        // returns exactly that reason with no veto and no severity
        // overrides. Emitting `"---\ntypesafe adjustments:\ntypesafe-unavailable"`
        // in the audit trail looks like typesafe did something when it
        // did not, which confuses operators reading the PR review. We
        // only emit the audit block for an override or a recorded disagreement.
        const hasRealAdjustment =
          reviewVerdict.severityOverrides.size > 0 ||
          reviewVerdict.reasons.some((r) => r !== "typesafe-unavailable");
        if (hasRealAdjustment) {
          const realReasons = reviewVerdict.reasons.filter((r) => r !== "typesafe-unavailable");
          const audit = `\n\n---\ntypesafe adjustments:\n${realReasons.join("\n")}`;
          state.specReview.notes = (state.specReview.notes ?? "") + audit;
        }
        // Bind the review verdict to the revision record so the
        // spec-loop's `previousSpecRevision` lookup on the next
        // iteration knows which findings came from which commit.
        const lastRev = spec.revisions?.at(-1);
        if (lastRev) {
          lastRev.reviewVerdict = state.specReview.verdict;
          lastRev.reviewFindings = state.specReview.findings;
        }
      }
      await publishSpecReviewDecision(state, state.specReview, deps.config, deps.store);
      if (state.specReview.verdict === 'REJECT') {
        await deps.store.save(state);
        await deps.creditLessons?.(state, 'review-spec');
        await deps.learn?.(state, 'spec', 'review-spec', 'SPEC_REVIEW_REJECTED',
          reviewRejectionDetail(state.specReview, 'The specification (PRODUCT.md + TECH.md)'));
        deps.logger.warn(`issue #${issue.number} spec review REJECTED; repairing ${state.specReview.findings?.length ?? 0} findings in the spec phase`);
        continue;
      }
      deps.logger.info(`issue #${issue.number} spec review APPROVED`);
      await deps.creditLessons?.(state, 'spec', 'review-spec');
      await mergeApprovedSpecification(deps, state);
      return;
    }
  }

async function mergeApprovedSpecification(deps: SpecPhaseDependencies, state: FactoryIssueState): Promise<void> {
  if (!hasSpecificationApproval(state) || !state.specs?.commitSha || !state.specs.specPrUrl) {
    throw new Error('Cannot merge a specification without matching approval and publication');
  }
  const { commitSha, specPrUrl } = state.specs;
  await deps.stage(state, 'merge-spec-pr', () => runExternalOp(state, current => deps.store.save(current), {
    kind: 'pr-merge', idempotencyKey: specPrUrl, payload: { prUrl: specPrUrl, expectedHeadSha: commitSha },
  }, () => mergePullRequest({ workdir: deps.repo.workdir, remotePath: deps.remotePath, prUrl: specPrUrl, expectedHeadSha: commitSha })));
  await runGitNetworkCommand(['fetch', 'origin', deps.repo.defaultBranch], { cwd: deps.repo.workdir });
  // Use the merged base for implementation without moving another worktree's main branch.
  await exec('git', ['checkout', '--detach', `origin/${deps.repo.defaultBranch}`], { cwd: deps.repo.workdir });
  delete state.correction;
  await deps.transition(state, 'ready-to-implement', undefined);
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
export function buildSpecFeedback(state: FactoryIssueState): string {
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
 * P2 (2026-09-18): when `state.specs` is null but the previous
 * spec run produced a body, the artifacts[] array still carries
 * the content hash + path. Read the file from disk and rebuild
 * a minimal `SpecPair` so the next spec agent can amend rather
 * than re-derive. The recovered body is best-effort: missing
 * files return `undefined` and the agent falls back to the
 * no-prior-content path.
 *
 * The `spec-product` / `spec-tech` artifacts are committed by
 * `recordSpecArtifacts` in the same save() call that originally
 * wrote state.specs, so their on-disk files reflect the spec
 * the reviewer actually saw. A future bug that wipes state.specs
 * (e.g. P0 above) cannot make the body unrecoverable while the
 * artifacts[] entry still points to the right file.
 */
export async function recoverPreviousSpecFromArtifacts(
  workdir: string,
  artifacts: FactoryIssueState['artifacts'],
): Promise<import('../core/types.js').SpecPair | undefined> {
  if (!artifacts || artifacts.length === 0) return undefined;
  // Most recent spec-product + spec-tech revisions.
  const lastProduct = [...artifacts].reverse().find((a) => a.kind === 'spec-product');
  const lastTech = [...artifacts].reverse().find((a) => a.kind === 'spec-tech');
  if (!lastProduct?.path || !lastTech?.path) return undefined;
  try {
    const productBody = await fs.readFile(path.join(workdir, lastProduct.path), 'utf8');
    const techBody = await fs.readFile(path.join(workdir, lastTech.path), 'utf8');
    // We can't recover the structured fields (goals, nonGoals,
    // acceptanceCriteria, …) from the markdown body alone — those
    // are produced by the spec agent's structured output, which
    // we no longer have. The spec agent re-derives them from
    // the body on the next iteration. The orchestrator passes
    // the bodies in via SpecRevisionInput; the spec agent knows
    // to do the parse.
    const slug = lastProduct.path.split('/').slice(-2, -1)[0] ?? 'recovered-spec';
    return {
      product: {
        slug,
        title: '',
        problem: '',
        goals: [],
        nonGoals: [],
        stories: [],
        acceptanceCriteria: [],
        openQuestions: [],
        body: productBody,
      },
      tech: {
        slug,
        approach: '',
        affectedAreas: [],
        dataModel: '',
        apiChanges: [],
        migrationPlan: '',
        validationPlan: [],
        alternatives: [],
        openQuestions: [],
        body: techBody,
      },
      specBranch: `spec/${slug}`,
      specPrUrl: '',
    };
  } catch {
    return undefined;
  }
}
