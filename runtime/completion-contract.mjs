import { createHash } from 'node:crypto';

export function hasSpecificationApproval(state) {
  const spec = state.specs;
  const review = state.specReview;
  if (!spec?.commitSha || !spec.specBranch || review?.verdict !== 'APPROVE'
    || state.specReviewedKey !== `${spec.specBranch}@${spec.commitSha}`
    || review.findings?.some(finding => finding.severity === 'blocking' && finding.status === 'open')) return false;
  const revision = spec.revisions?.at(-1);
  return !revision || (revision.commitSha === spec.commitSha && review.revisionId === revision.id);
}

export function acceptanceRequirements(spec) {
  return (spec?.product.acceptanceCriteria ?? []).map((criterion, index) => ({ id: `AC-${index + 1}`, criterion }));
}
export function acceptanceRequirementsHash(spec) {
  return createHash('sha256').update(JSON.stringify(acceptanceRequirements(spec))).digest('hex');
}
export function verificationChecksHash(checks) {
  return createHash('sha256').update(JSON.stringify((checks ?? []).map(check => ({
    criterion: check.criterion, requirementIds: check.requirementIds, passed: check.passed, receiptIds: check.receiptIds,
    ...(check.kind === undefined ? {} : { kind: check.kind }),
  })))).digest('hex');
}
export function hasVerificationJudgment(result) {
  const proof = result?.judgment, checks = result?.checks ?? [];
  return Boolean(proof && proof.runId === result.coverage?.runId && proof.runId
    && proof.checksHash === verificationChecksHash(checks) && proof.verdict === 'verified'
    && Number.isFinite(proof.confidence) && proof.confidence >= 0 && proof.confidence <= 1
    && checks.length && Array.isArray(proof.checks) && proof.checks.length === checks.length
    && checks.every((_, index) => proof.checks.some(check => check.index === index
      && Number.isFinite(check.probability) && check.probability >= 0.5 && check.probability <= 1)));
}
export function hasAcceptanceCoverage(spec, sha, result) {
  const required = acceptanceRequirements(spec);
  const proof = result?.coverage;
  if (!sha || !spec?.commitSha || !required.length || required.some(item => !item.criterion.trim())
    || !proof || proof.specCommitSha !== spec.commitSha || proof.implementationSha !== sha
    || proof.requirementsHash !== acceptanceRequirementsHash(spec) || !proof.runId) return false;
  const checks = result?.checks ?? [];
  return required.every(item => checks.some(check => check.passed === true
    && check.requirementIds?.includes(item.id) && check.receiptIds.length > 0
    && check.receiptIds.every(id => proof.passingReceiptIds.includes(id))))
    && checks.every(check => check.passed === true && check.receiptIds.length > 0
      && check.receiptIds.every(id => proof.passingReceiptIds.includes(id))
      && (check.kind === 'operator-regression' ? Array.isArray(check.requirementIds) && check.requirementIds.length === 0 && check.receiptIds.length === 1
        : check.kind === undefined && check.requirementIds?.length
          && check.requirementIds.every(id => required.some(item => item.id === id))));
}
export function hasImplementationApproval(state) {
  const sha = state.implementation?.commitSha;
  return Boolean(hasSpecificationApproval(state) && sha && state.review?.verdict === 'APPROVE' && state.reviewedSha === sha
    && state.verifiedSha === sha && state.implementation?.behaviorVerification?.status === 'verified'
    && hasVerificationJudgment(state.implementation.behaviorVerification)
    && hasAcceptanceCoverage(state.specs, sha, state.implementation.behaviorVerification));
}
export function canConfirmMergedImplementation(state, pr, defaultBranch) {
  return hasImplementationApproval(state) && pr.merged === true
    && pr.html_url === state.implementation?.prUrl && pr.head?.sha === state.implementation?.commitSha
    && pr.base?.ref === defaultBranch;
}
