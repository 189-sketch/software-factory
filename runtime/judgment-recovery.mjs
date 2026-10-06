import { createHash } from 'node:crypto';
import { businessInputHash } from './business-input.mjs';
import { PIPELINE_LABELS_TO_CLEAR } from './pipeline-definition.mjs';
import { hasVerificationJudgment, hasSpecificationApproval, acceptanceRequirementsHash } from './completion-contract.mjs';
import { reviewJudgmentContextHash, needsReviewJudgmentContextRecovery } from './review-judgment-context.mjs';

// Version the actual AC-scoped input protocol, never a build, model answer or retry.
export const VERIFICATION_JUDGMENT_CONTRACT_VERSION = 1;

/** Classify adapter-owned failures, never product text or model-generated recovery advice. */
export function classifyJudgmentUnavailable(warnings) {
  const text = warnings.join(' ');
  if (text.includes('max_tokens_exceeded')) return { kind: 'capacity', code: 'MAX_TOKENS_EXCEEDED' };
  if (/TYPESAFE_API_KEY missing|FACTORY_TYPESAFE_OFF=1|http (401|403)\b/.test(text)) {
    return { kind: 'configuration', code: 'JUDGMENT_CONFIGURATION_UNAVAILABLE' };
  }
  if (/http (429|529|5\d\d)\b|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|aborted|timeout/i.test(text)) {
    return { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' };
  }
  return { kind: 'contract', code: 'JUDGMENT_CONTRACT_INVALID' };
}

/** A versioned judgment contract, not an issue-specific exception or workflow approval. */
export function judgmentRecoveryContext(state, stage) {
  return createHash('sha256').update(JSON.stringify({ version: 1, stage,
    input: businessInputHash({ ...state.issue, labels: state.issue.labels.filter(label => !PIPELINE_LABELS_TO_CLEAR.includes(label)) }),
    spec: state.specs?.commitSha, implementation: state.implementation?.commitSha, base: state.reviewedBaseSha,
    model: process.env.FACTORY_TYPESAFE_MODEL ?? 'jev-latest',
    ...(stage === 'review' && state.review ? { reviewInput: reviewJudgmentContextHash(state) } : {}),
    ...(stage === 'verify' ? { requestContractVersion: VERIFICATION_JUDGMENT_CONTRACT_VERSION } : {}),
  })).digest('hex');
}

/** A repaired input contract can resume old capacity failures, not configuration or product failures. */
export function needsVerificationJudgmentContractRecovery(state) {
  const result = state?.implementation?.behaviorVerification;
  const failure = result?.judgmentFailure;
  if (state?.status !== 'waiting' || state.merged || state.issue?.state === 'closed'
    || state.nextLabel !== 'verify-failed' || state.wait?.reason !== 'blocked-operator'
    || result?.status !== 'blocked' || failure?.kind !== 'capacity' || failure.code !== 'MAX_TOKENS_EXCEEDED') return false;
  const previous = failure.requestContractVersion === undefined ? 0 : failure.requestContractVersion;
  if (!Number.isSafeInteger(previous) || previous < 0) {
    throw Object.assign(new Error('Invalid judgment request contract version'), { code: 'FACTORY_STATE_JUDGMENT_CONTRACT_INVALID' });
  }
  // A rollback must not reopen a failure emitted by a newer daemon.
  if (previous >= VERIFICATION_JUDGMENT_CONTRACT_VERSION) return false;
  const sha = state.implementation.commitSha, coverage = result.coverage;
  return Boolean(hasSpecificationApproval(state) && sha && state.review?.verdict === 'APPROVE' && state.reviewedSha === sha
    && !state.review.judgmentFailure && coverage?.runId
    && coverage.specCommitSha === state.specs.commitSha && coverage.implementationSha === sha
    && coverage.requirementsHash === acceptanceRequirementsHash(state.specs));
}

export function needsJudgmentRecovery(state) {
  const sha = state?.implementation?.commitSha;
  return Boolean(state?.status === 'waiting' && !state.merged && state.issue?.state !== 'closed'
    && state.nextLabel === 'verified' && sha && state.review?.verdict === 'APPROVE' && state.reviewedSha === sha
    && (!state.review.mergeRoute || (state.implementation.behaviorVerification?.status === 'verified'
      && !hasVerificationJudgment(state.implementation.behaviorVerification))));
}

export function judgmentRetryPending(state, now = Date.now()) {
  const wait = state?.wait;
  if (wait?.reason !== 'judgment-retry') return false;
  if (!['review', 'verify'].includes(wait.stage) || !/^[a-f0-9]{64}$/.test(wait.context)
    || !Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || !Number.isFinite(Date.parse(wait.nextAttemptAt))) {
    throw Object.assign(new Error('Invalid judgment recovery checkpoint'), { code: 'FACTORY_STATE_JUDGMENT_RECOVERY_INVALID' });
  }
  return wait.context === judgmentRecoveryContext(state, wait.stage) && Date.parse(wait.nextAttemptAt) > now;
}

/** Mechanical recovery admission, not a semantic approval or a freshness vote. */
export function judgmentResumeStage(state, now = Date.now()) {
  if (state?.merged || state?.issue?.state === 'closed') return undefined;
  if (state?.wait?.reason === 'judgment-retry') {
    return judgmentRetryPending(state, now) ? undefined : state.wait.stage;
  }
  if (needsVerificationJudgmentContractRecovery(state)) return 'verify';
  if (needsReviewJudgmentContextRecovery(state)) return 'review';
  if (needsJudgmentRecovery(state)) return state.review.mergeRoute ? 'verify' : 'review';
  return undefined;
}

/** Persistent service backoff; expiry retries judgment, never authorizes product repair. */
export function scheduleJudgmentRetry(state, stage, baseDelayMs, maxDelayMs, now = Date.now()) {
  if (!['review', 'verify'].includes(stage) || !Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1
    || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new Error('Invalid judgment retry policy');
  const context = judgmentRecoveryContext(state, stage);
  judgmentRetryPending(state, now); // Reject corrupt counters even when a context has changed.
  const prior = state.wait?.reason === 'judgment-retry' && state.wait.context === context ? state.wait : undefined;
  const attempts = (prior?.attempts ?? 0) + 1;
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempts - 1, 20));
  const nextAttemptAt = new Date(now + delay).toISOString();
  return { reason: 'judgment-retry', stage, context, attempts, nextAttemptAt, since: prior?.since ?? new Date(now).toISOString(),
    note: `${stage} 的独立判断尚不可用，保留实现、审查内容和执行收据；第 ${attempts} 次恢复将在 ${nextAttemptAt} 自动重试。无需回复或批准，不能据此合并或关闭 issue。` };
}
