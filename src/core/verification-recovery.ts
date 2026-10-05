import type { FactoryIssueState } from './types.js';
import { acceptanceRequirements, acceptanceRequirementsHash, verificationChecksHash } from './completion-contract.js';
import { verificationRecoveryContext, validateVerificationRecovery } from '../../runtime/verification-capabilities.mjs';

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
