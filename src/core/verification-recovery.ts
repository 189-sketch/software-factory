import { createHash } from 'node:crypto';
import type { FactoryIssueState } from './types.js';
import { acceptanceRequirements, acceptanceRequirementsHash } from './completion-contract.js';

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
  const context = createHash('sha256').update(JSON.stringify({ spec: state.specs?.commitSha,
    implementation: state.implementation?.commitSha, requirements: acceptanceRequirementsHash(state.specs), inputHash })).digest('hex');
  const previous = state.verificationRecovery;
  if (previous && (!/^[a-f0-9]{64}$/.test(previous.context) || !Number.isSafeInteger(previous.attempts)
    || previous.attempts < 1 || !Array.isArray(previous.coveredRequirementIds)
    || previous.coveredRequirementIds.some(id => typeof id !== 'string'))) {
    throw Object.assign(new Error('Invalid verification recovery checkpoint'), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
  }
  const bound = result?.coverage?.specCommitSha === state.specs?.commitSha
    && result?.coverage?.implementationSha === state.implementation?.commitSha
    && result?.coverage?.requirementsHash === acceptanceRequirementsHash(state.specs);
  const covered = bound ? result?.checks?.filter(check => check.passed && check.receiptIds.length
    && check.receiptIds.every(id => result.coverage?.passingReceiptIds.includes(id)))
    .flatMap(check => check.requirementIds ?? []).filter(id => required.includes(id)) ?? [] : [];
  const prior = previous?.context === context ? previous : undefined;
  const progress = covered.some(id => !prior?.coveredRequirementIds.includes(id));
  state.verificationRecovery = { context, attempts: !prior || progress ? 1 : prior.attempts + 1,
    coveredRequirementIds: [...new Set([...(prior?.coveredRequirementIds ?? []), ...covered])].sort() };
  return state.verificationRecovery.attempts < maxAttempts ? 'retry' : 'park';
}
