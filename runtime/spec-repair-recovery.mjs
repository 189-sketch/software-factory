export const SPEC_REPAIR_VERSION = 3;

/** Wake specs parked by legacy automatic-repair limits, preserving all findings and history. */
export function needsSpecRepairRecovery(state) {
  if (!state || state.merged || state.issue?.state === 'closed' || state.specLoopVersion >= SPEC_REPAIR_VERSION
      || !['waiting', 'failed'].includes(state.status) || state.nextLabel !== 'needs-info'
      || !state.specs?.product?.body || !state.specs?.tech?.body || state.specReview?.verdict !== 'REJECT') return false;
  const failure = state.lastFailure;
  return Boolean((failure?.stage === 'review-spec' && failure.class === 'AGENT_REASONING'
    && failure.message?.startsWith('Spec review REJECTED:'))
    || (failure?.class === 'USER_INPUT_REQUIRED' && /Spec (?:rubric convergence ratchet|typesafe veto budget exhausted)/.test(failure.message ?? '')));
}
