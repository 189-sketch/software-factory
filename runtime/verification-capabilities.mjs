import { createHash } from 'node:crypto';
import { businessInputHash } from './business-input.mjs';
import { PIPELINE_LABELS_TO_CLEAR } from './pipeline-definition.mjs';
import { acceptanceRequirementsHash, hasSpecificationApproval } from './completion-contract.mjs';

export const BROWSER_ACTIONS = Object.freeze(['open', 'click', 'fill', 'assert_text', 'assert_text_contains',
  'assert_value', 'assert_visible', 'assert_not_visible', 'assert_url', 'screenshot']);
// Change protocol versions only when execution/evidence semantics change, not for builds or prompts.
export const VERIFICATION_CAPABILITY_HASH = createHash('sha256').update(JSON.stringify({
  processEvidence: 1, browserEvidence: 2, browserActions: BROWSER_ACTIONS, managedService: 1, immutableRunEvidence: 1,
  acceptanceRegistrationFeedback: 1,
  operatorRegressionRegistration: 1,
})).digest('hex');

export function validateVerificationRecovery(record) {
  if (record && (!/^[a-f0-9]{64}$/.test(record.context) || !Number.isSafeInteger(record.attempts)
    || record.attempts < 1 || !Array.isArray(record.coveredRequirementIds)
    || record.coveredRequirementIds.some(id => typeof id !== 'string')
    || [record.capabilities, record.pendingCapabilities].some(value => value !== undefined && !/^[a-f0-9]{64}$/.test(value)))) {
    throw Object.assign(new Error('Invalid verification recovery checkpoint'), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
  }
}

/** Missing capabilities keeps the exact pre-versioning context, preserving legacy budgets. */
export function verificationRecoveryContext(state, inputHash, capabilities) {
  if (capabilities !== undefined && !/^[a-f0-9]{64}$/.test(capabilities)) {
    throw Object.assign(new Error('Invalid verification execution capabilities'), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
  }
  return createHash('sha256').update(JSON.stringify({ spec: state.specs?.commitSha,
    implementation: state.implementation?.commitSha, requirements: acceptanceRequirementsHash(state.specs),
    inputHash, ...(capabilities === undefined ? {} : { capabilities }) })).digest('hex');
}

/** A changed executor can admit fresh evidence, never approve or repair the product. */
export function needsVerificationCapabilityRecovery(state) {
  const result = state?.implementation?.behaviorVerification;
  if (state?.status !== 'waiting' || state.merged || state.issue?.state === 'closed'
    || !['not-verified', 'blocked'].includes(result?.status) || result.judgmentFailure
    || !['evidence', 'tool'].includes(result.failure?.kind) || !state.verificationRecovery) return false;
  const prior = state.verificationRecovery;
  validateVerificationRecovery(prior);
  const parked = state.nextLabel === 'verify-failed' && state.wait?.reason === 'blocked-operator';
  const interrupted = state.nextLabel === 'ready-to-merge' && prior.pendingCapabilities !== undefined;
  if (!parked && !interrupted) return false;
  if (result.executionCapabilities !== undefined && !/^[a-f0-9]{64}$/.test(result.executionCapabilities)) {
    throw Object.assign(new Error('Invalid verification execution capabilities'), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
  }
  // Legacy browser evidence predates URL/negative assertions and causal action receipts.
  if (result.executionCapabilities === VERIFICATION_CAPABILITY_HASH
    || (!result.executionCapabilities && !['browser', 'hybrid'].includes(result.channel))) return false;
  const coverage = result.coverage;
  const sha = state.implementation.commitSha;
  if (!hasSpecificationApproval(state) || !sha || state.review?.verdict !== 'APPROVE' || state.reviewedSha !== sha
    || !coverage?.runId || result.failure.runId !== coverage.runId
    || coverage.specCommitSha !== state.specs.commitSha || coverage.implementationSha !== sha
    || coverage.requirementsHash !== acceptanceRequirementsHash(state.specs)
    || (prior.capabilities !== undefined && prior.capabilities !== result.executionCapabilities)) return false;
  const input = businessInputHash({ ...state.issue,
    labels: state.issue.labels.filter(label => !PIPELINE_LABELS_TO_CLEAR.includes(label)) });
  return prior.context === verificationRecoveryContext(state, input, prior.capabilities);
}
