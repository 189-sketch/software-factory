import type { FactoryIssueState } from '../core/types.js';

/**
 * Decide which stage-output fields must be invalidated when the
 * supervisor reroutes an issue to `targetStage`. The plan §3.4
 * "reroute 按目标阶段保留修订所需产物与反馈, 只使受影响的下游结果失效"
 * means: keep everything upstream of (and including) the target
 * stage, drop the target's own output and anything downstream of it.
 *
 * - `triage`             — no prior stage output; drop everything that came after.
 * - `spec`               — drop specs/specReview/specReviewedKey (the target's own
 *                          output) and everything downstream; keep `correction`
 *                          so the next spec agent sees the supervisor feedback.
 * - `review-spec`        — drop everything downstream of review-spec
 *                          (implementation, review, sha fields); keep specs /
 *                          specReview / specReviewedKey / correction.
 * - `implementation`     — drop review / sha / verifiedSha; keep specs /
 *                          specReview / correction / implementation.
 * - `review-pr`          — drop verifiedSha; keep implementation / reviewedSha /
 *                          reviewedBaseSha / review / correction.
 * - `verify-behavior`    — verify is the terminal stage; keep everything.
 *
 * Exported for unit tests so the reroute preservation table can be
 * asserted without spinning up the orchestrator.
 */
export function rerouteInvalidatedFields(targetStage: string | undefined): string[] {
  switch (targetStage) {
    case 'triage':
      // Reroute to triage means the supervisor has no confidence in
      // anything the current pipeline produced. Wipe every stage's
      // output so triage starts from a clean slate.
      return ['specs', 'specReview', 'specReviewedKey', 'implementation', 'review', 'reviewedSha', 'reviewedBaseSha', 'verifiedSha'];
    case 'spec':
      // Reroute to spec: the previous spec body must be PRESERVED so
      // the next spec agent can amend it (rather than re-derive from
      // scratch). The review verdict IS invalidated because the next
      // spec commit changes the SHA; only `specReviewedKey` (the
      // cache key) needs to drop so review-spec re-runs. Downstream
      // artefacts (implementation, review, verifiedSha) are also
      // cleared because the new spec may invalidate them. P0 fix
      // (2026-09-18): previously `specs` was wiped here, which made
      // the spec-review dead loop structurally unrecoverable.
      return ['specReviewedKey', 'implementation', 'review', 'reviewedSha', 'reviewedBaseSha', 'verifiedSha'];
    case 'review-spec':
      return ['implementation', 'review', 'reviewedSha', 'reviewedBaseSha', 'verifiedSha'];
    case 'implementation':
      return ['review', 'reviewedSha', 'reviewedBaseSha', 'verifiedSha'];
    case 'review-pr':
      return ['verifiedSha'];
    case 'verify-behavior':
      return [];
    default:
      // Unknown target — be conservative and invalidate the same set
      // the original code did, minus `correction` (which must always
      // survive so the supervisor feedback is not lost).
      return ['specs', 'specReview', 'specReviewedKey', 'implementation', 'review', 'reviewedSha', 'reviewedBaseSha', 'verifiedSha'];
  }
}

/**
 * Convenience wrapper: list the fields kept on reroute (everything in
 * `FactoryIssueState` that is stage-specific, minus the invalidated
 * set). Used to annotate the reroute event so an operator can see at
 * a glance which products survived.
 */
export function reroutePreservedFields(targetStage: string | undefined): string[] {
  const allStageFields = [
    'specs',
    'specReview',
    'specReviewedKey',
    'implementation',
    'review',
    'reviewedSha',
    'reviewedBaseSha',
    'verifiedSha',
  ];
  const invalidated = new Set(rerouteInvalidatedFields(targetStage));
  return allStageFields.filter((f) => !invalidated.has(f));
}

/**
 * Delete the reroute-invalidated fields from `state` in place. Always
 * leaves `correction` intact — the supervisor's feedback is the most
 * important input the rerouted stage needs and F02 is the evidence
 * that dropping it silently breaks the next attempt.
 */
export function clearRerouteInvalidatedFields(
  state: Pick<FactoryIssueState, 'specs' | 'specReview' | 'specReviewedKey' | 'implementation' | 'review' | 'reviewedSha' | 'reviewedBaseSha' | 'verifiedSha'>,
  targetStage: string | undefined,
): void {
  for (const field of rerouteInvalidatedFields(targetStage)) {
    delete (state as Record<string, unknown>)[field];
  }
}
