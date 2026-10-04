import type { FactoryIssueState } from '../core/types.js';

/** Execution requires approval bound to the current specification, not a triage label. */
export function hasSpecificationApproval(state: FactoryIssueState): boolean {
  const spec = state.specs;
  const review = state.specReview;
  if (!spec?.commitSha || !spec.specBranch || review?.verdict !== 'APPROVE'
    || state.specReviewedKey !== `${spec.specBranch}@${spec.commitSha}`
    || review.findings?.some(finding => finding.severity === 'blocking' && finding.status === 'open')) return false;
  const revision = spec.revisions?.at(-1);
  return !revision || (revision.commitSha === spec.commitSha && review.revisionId === revision.id);
}

/** An approved spec branch is a recovery ref; rejected specs never provide an execution base. */
export function resolveSpecFallbackRef(state: FactoryIssueState): string | null {
  if (!hasSpecificationApproval(state)) return null;
  return `origin/${state.specs!.specBranch}`;
}
