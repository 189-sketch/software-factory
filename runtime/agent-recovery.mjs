import { normalizeStageId } from './pipeline-definition.mjs';

/** Admit only controller-recorded executor faults; product questions and operator blocks stay parked. */
export function agentRuntimeRecoveryStage(state) {
  if (!state || ['completed','cancelled'].includes(state.status) || state.issue?.state === 'closed' || state.wait?.reason === 'blocked-operator') return null;
  const current = state.agentRuntimeFailure;
  if (current && /^FACTORY_AGENT_/.test(current.code ?? '')) return normalizeStageId(current.stage);
  const failure = state.lastFailure;
  if (failure?.class === 'AGENT_REASONING' && normalizeStageId(failure.stage) === 'implementation'
    && failure.message === 'Implementation supplied no validation commands; refusing to publish') return 'implementation';
  if (failure?.class === 'EXECUTOR_CRASH'
    && String(state.error ?? '').startsWith('[failure-classifier] EXECUTOR_CRASH:')
    && /dispatcher run failed: (?:claude-code exited with code \d+|claude CLI reported error_)/.test(failure.message ?? '')) {
    return normalizeStageId(failure.stage);
  }
  return null;
}
