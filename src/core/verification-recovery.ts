import type { FactoryIssueState } from './types.js';
import { acceptanceRequirements, acceptanceRequirementsHash, hasSpecificationApproval, verificationChecksHash } from './completion-contract.js';
import { verificationRecoveryContext, validateVerificationRecovery } from '../../runtime/verification-capabilities.mjs';

/** Diagnostic obligations only: prior receipts never satisfy a new execution. */
export function buildVerificationRecoveryPlan(state: FactoryIssueState) {
  const result = state.implementation?.behaviorVerification;
  const coverage = result?.coverage;
  const requirements = acceptanceRequirements(state.specs);
  const checks = result?.checks ?? [];
  const boundToCurrentApproval = Boolean(hasSpecificationApproval(state)
    && state.implementation?.commitSha && state.review?.verdict === 'APPROVE'
    && state.reviewedSha === state.implementation.commitSha && coverage?.runId
    && coverage.specCommitSha === state.specs?.commitSha
    && coverage.implementationSha === state.implementation.commitSha
    && coverage.requirementsHash === acceptanceRequirementsHash(state.specs));
  const proof = result?.judgment;
  const judged = Boolean(boundToCurrentApproval && proof?.runId === coverage?.runId
    && proof?.checksHash === verificationChecksHash(checks));
  const checksNeedingEvidence = checks.flatMap((check, index) => {
    const reasons: string[] = [];
    if (!boundToCurrentApproval) reasons.push('stale-or-unapproved-execution');
    const engineering = check.kind === 'operator-regression' && Array.isArray(check.requirementIds)
      && check.requirementIds.length === 0 && check.receiptIds.length === 1;
    if (!engineering && (!check.requirementIds?.length || check.requirementIds.some(id => !requirements.some(item => item.id === id)))) {
      reasons.push('missing-or-unknown-requirement');
    }
    if (!check.receiptIds.length || check.receiptIds.some(id => !coverage?.passingReceiptIds.includes(id))) {
      reasons.push('missing-or-nonpassing-receipt');
    }
    const answers = judged ? proof!.checks.filter(answer => answer.index === index) : [];
    if (answers.length !== 1 || !Number.isFinite(answers[0]!.probability)
      || answers[0]!.probability < 0 || answers[0]!.probability > 1) reasons.push('missing-or-unbound-judgment');
    else if (answers[0]!.probability < 0.5) reasons.push('unsupported-independent-judgment');
    if (!check.passed) reasons.push('negative-check-not-product-defect-proof');
    return reasons.length ? [{ index, criterion: check.criterion, ...(check.kind ? { kind: check.kind } : {}),
      requirementIds: [...(check.requirementIds ?? [])], receiptIds: [...check.receiptIds], reasons }] : [];
  });
  return { sourceRunId: coverage?.runId, boundToCurrentApproval,
    approvedRequirements: requirements,
    unregisteredRequirementIds: requirements.filter(item => !boundToCurrentApproval
      || !checks.some(check => check.requirementIds?.includes(item.id))).map(item => item.id),
    checksNeedingEvidence,
    instruction: 'Use prior check/receipt references only to locate evidence gaps, never as current-run proof. Rerun and register every approved AC with exact new receipts; do not modify product code or change recovery budgets. Inspect registrationGaps, including operator regression receipt citations.' };
}

/** Only a factory-bound, independently judged failed AC can authorize product repair. */
export function hasProductVerificationFailure(state: FactoryIssueState): boolean {
  const result = state.implementation?.behaviorVerification;
  const failure = result?.failure;
  return Boolean(result?.status === 'not-verified' && failure?.kind === 'product' && failure.runId
    && failure.runId === result.coverage?.runId && result.coverage.specCommitSha === state.specs?.commitSha
    && result.coverage.implementationSha === state.implementation?.commitSha
    && result.coverage.requirementsHash === acceptanceRequirementsHash(state.specs)
    && failure.receiptIds.length && failure.requirementIds.length
    && failure.receiptIds.every(id => !result.coverage!.passingReceiptIds.includes(id))
    && failure.requirementIds.every(id => acceptanceRequirements(state.specs).some(item => item.id === id))
    && result.checks?.some(check => !check.passed && check.requirementIds?.some(id => failure.requirementIds.includes(id))
      && check.receiptIds.some(id => failure.receiptIds.includes(id))));
}

/** Accumulate actual AC progress, not new run IDs, notes, or checkpoint revisions. */
export function advanceVerificationRecovery(state: FactoryIssueState, inputHash: string, maxAttempts: number): 'retry' | 'park' {
  const result = state.implementation?.behaviorVerification;
  const required = acceptanceRequirements(state.specs).map(item => item.id);
  const capabilities = result?.executionCapabilities;
  const context = verificationRecoveryContext(state, inputHash, capabilities);
  const previous = state.verificationRecovery;
  validateVerificationRecovery(previous);
  const bound = result?.coverage?.specCommitSha === state.specs?.commitSha
    && result?.coverage?.implementationSha === state.implementation?.commitSha
    && result?.coverage?.requirementsHash === acceptanceRequirementsHash(state.specs);
  const checks = result?.checks ?? [];
  const proof = result?.judgment;
  const judged = proof?.runId === result?.coverage?.runId && proof?.checksHash === verificationChecksHash(checks);
  // One passing sub-check must not hide another unsupported claim for the same AC.
  const covered = bound && judged ? required.filter(id => {
    const related = checks.map((check, index) => ({ check, index })).filter(({ check }) => check.requirementIds?.includes(id));
    return related.length > 0 && related.every(({ check, index }) => {
      const answers = proof!.checks.filter(answer => answer.index === index);
      return check.passed && check.receiptIds.length > 0
        && check.receiptIds.every(receipt => result!.coverage!.passingReceiptIds.includes(receipt))
        && answers.length === 1 && Number.isFinite(answers[0]!.probability)
        && answers[0]!.probability >= 0.5 && answers[0]!.probability <= 1;
    });
  }) : [];
  const prior = previous?.context === context ? previous : undefined;
  const progress = covered.some(id => !prior?.coveredRequirementIds.includes(id));
  state.verificationRecovery = { context, attempts: !prior || progress ? 1 : prior.attempts + 1,
    coveredRequirementIds: [...new Set([...(prior?.coveredRequirementIds ?? []), ...covered])].sort(),
    ...(capabilities === undefined ? {} : { capabilities }) };
  return state.verificationRecovery.attempts < maxAttempts ? 'retry' : 'park';
}
