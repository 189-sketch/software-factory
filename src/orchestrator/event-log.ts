import type { FactoryIssueState, AgentEvent } from '../core/types.js';

/**
 * Append a stage event to the durable event log. Kept tiny so it's
 * safe to call on every transition without bloating the checkpoint.
 * Exported for tests so the event-log contract is verifiable without
 * spinning up a full orchestrator.
 */
export function appendEvent(state: FactoryIssueState, event: AgentEvent): void {
  state.events ??= [];
  state.events.push(event);
}

/**
 * Pull a `verdict` field out of a stage result if it has one. Stages
 * that don't produce a verdict (`triage`, `implementation`, `verify`)
 * return undefined, so the event log stays uncluttered.
 */
export function extractVerdict(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const verdict = (result as { verdict?: unknown }).verdict;
  return typeof verdict === 'string' ? verdict : undefined;
}
