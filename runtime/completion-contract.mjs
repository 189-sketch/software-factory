import { createHash } from 'node:crypto';

export function acceptanceRequirements(spec) {
  return (spec?.product.acceptanceCriteria ?? []).map((criterion, index) => ({ id: `AC-${index + 1}`, criterion }));
}
export function acceptanceRequirementsHash(spec) {
  return createHash('sha256').update(JSON.stringify(acceptanceRequirements(spec))).digest('hex');
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
      && check.receiptIds.every(id => proof.passingReceiptIds.includes(id)) && check.requirementIds?.length
      && check.requirementIds.every(id => required.some(item => item.id === id)));
}
export function hasImplementationApproval(state) {
  const sha = state.implementation?.commitSha;
  return Boolean(sha && state.review?.verdict === 'APPROVE' && state.reviewedSha === sha
    && state.verifiedSha === sha && state.implementation?.behaviorVerification?.status === 'verified'
    && hasAcceptanceCoverage(state.specs, sha, state.implementation.behaviorVerification));
}
export function canConfirmMergedImplementation(state, pr, defaultBranch) {
  return hasImplementationApproval(state) && pr.merged === true
    && pr.html_url === state.implementation?.prUrl && pr.head?.sha === state.implementation?.commitSha
    && pr.base?.ref === defaultBranch;
}
