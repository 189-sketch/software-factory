import type { FactoryIssueState } from '../core/types.js';
import { hasSpecificationApproval } from './spec-fallback.js';

/** Reopen a factual technical defect only after independent source-backed review. */
export function beginTechnicalSpecificationRepair(state: FactoryIssueState, confidenceFloor: number): boolean {
  const review = state.review, spec = state.specs;
  if (!spec || !hasSpecificationApproval(state) || review?.verdict !== 'REJECT'
    || review.judgmentFailure || !review.mergeRoute || review.generatedReview?.specCommitSha !== spec.commitSha
    || state.reviewedSha !== state.implementation?.commitSha
    || review.typesafeBatch?.b4.value !== 'REJECT' || !(review.typesafeBatch.b4.confidence >= confidenceFloor)) return false;
  const path = `specs/${spec.tech.slug}/TECH.md`;
  const findings = (review.findings ?? []).filter(finding => finding.status === 'open'
    && ['blocking', 'important'].includes(finding.severity) && finding.evidence.path === path
    && Number.isSafeInteger(finding.evidence.line) && finding.evidence.line! > 0
    && review.typesafeBatch!.b5.some(answer => answer.findingId === finding.id
      && ['blocking', 'important'].includes(answer.value) && answer.confidence >= confidenceFloor));
  if (!findings.length) return false;
  state.specificationRepair = { sourceSpecSha: spec.commitSha!, findingIds: findings.map(finding => finding.id) };
  state.specReview = { verdict: 'REJECT', body: 'Technical specification defects confirmed during implementation review.',
    comments: [], notes: review.body, findings: structuredClone(findings) };
  delete state.specReviewedKey;
  delete state.wait;
  state.correction = { targetStage: 'spec', turns: [
    'Implementation review found factual errors in the approved technical design. Correct TECH.md through normal specification generation, review, publication and merge. Preserve PRODUCT.md and human constraints exactly. Do not rewrite the product to reproduce a disproven technical assumption.',
    `Confirmed findings: ${JSON.stringify(findings)}`,
  ] };
  return true;
}

/** A new approved revision returns to the retained implementation, never bypassing its gates. */
export function finishTechnicalSpecificationRepair(state: FactoryIssueState): boolean {
  const repair = state.specificationRepair;
  if (!repair || !hasSpecificationApproval(state) || state.specs?.commitSha === repair.sourceSpecSha) return false;
  for (const finding of state.review?.findings ?? []) {
    if (!repair.findingIds.includes(finding.id)) continue;
    finding.status = 'resolved';
    finding.resolutionNote = `Technical specification revised and independently approved at ${state.specs!.commitSha}`;
  }
  delete state.verifiedSha;
  delete state.mergeCandidate;
  if (state.implementation) delete state.implementation.behaviorVerification;
  state.correction = { targetStage: 'implementation', turns: [
    'The technical specification has been corrected and independently approved. Reconcile the retained implementation branch with this approved revision, then repair the remaining product findings. Historical technical findings do not authorize reverting the corrected design. Reproduce the defect in the real application lifecycle and add regression coverage before fixing it. Run normal validation and return for fresh review and acceptance.',
  ] };
  delete state.specificationRepair;
  return true;
}
