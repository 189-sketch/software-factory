/**
 * Local conversation bindings, scoped by the enclosing issue and agent role.
 * Workdir and backend are compatibility guards, not session keys.
 * Revisions, execution run IDs and model changes do not reset conversation.
 * The orchestrator durably saves new ownership before spawning the CLI.
 */
import type { AgentBackend } from "../../runtime/agent-backends.d.mts";
import path from 'node:path';
import type { FactoryIssueState, ProviderSessionMap, SessionBinding, SessionContextUsage } from "./types.js";

/** Inputs to `bindProviderSession`. */
export interface BindSessionInput {
  /** UUID returned by the CLI's `--output-format json` envelope
   * (`session_id` for Claude Code; the adapter normalizes backend-
   * specific field names into this single string). */
  providerSessionId: string;
  /** Backend that minted the session. */
  backend: AgentBackend;
  /** Last selected model, retained as diagnostic metadata. */
  model: string;
  workdir?: string;
  inputRevision?: string;
  /** ISO timestamp; defaults to now. */
  boundAt?: string;
  /** 1-based attempt number; defaults to previous binding + 1, or 1. */
  attempt?: number;
  contextUsage?: SessionContextUsage | null;
}

/** Record the live conversation for one agent without touching other agents. */
export function bindProviderSession(
  state: FactoryIssueState,
  role: string,
  input: BindSessionInput,
): SessionBinding {
  const existing = state.providerSessions?.[role];
  const boundAt = input.boundAt ?? new Date().toISOString();
  const attempt = input.attempt ?? (existing ? existing.attempt + 1 : 1);
  const binding: SessionBinding = {
    providerSessionId: input.providerSessionId,
    backend: input.backend,
    model: input.model,
    ...(input.workdir ? { workdir: path.resolve(input.workdir) } : {}),
    ...(input.inputRevision ? { inputRevision: input.inputRevision } : {}),
    lastUsedAt: boundAt,
    attempt,
    ...(input.contextUsage ? {contextUsage:input.contextUsage}
      : input.contextUsage === undefined && existing?.providerSessionId === input.providerSessionId && existing.contextUsage
        ? {contextUsage:existing.contextUsage} : {}),
  };
  const next: ProviderSessionMap = { ...(state.providerSessions ?? {}) };
  next[role] = binding;
  state.providerSessions = next;
  return binding;
}

/** Resume the same issue + agent, refusing foreign backends and worktrees. */
export function getProviderSession(
  state: FactoryIssueState,
  role: string,
  requestedBackend: AgentBackend,
  _requestedModel: string,
  requestedWorkdir?: string,
  _requestedInputRevision?: string,
): SessionBinding | undefined {
  const binding = state.providerSessions?.[role];
  if (!binding) return undefined;
  if (binding.backend !== requestedBackend) return undefined;
  if (requestedWorkdir && (!binding.workdir || path.resolve(binding.workdir) !== path.resolve(requestedWorkdir))) return undefined;
  return binding;
}

/** Explicitly remove a binding during an operator-requested session reset. */
export function clearProviderSession(state: FactoryIssueState, role: string): void {
  const current = state.providerSessions;
  if (!current || !(role in current)) return;
  const next: ProviderSessionMap = { ...current };
  delete next[role];
  state.providerSessions = next;
}

/** Attach the current agent's conversation to its execution context. */
export function attachResumeSessionId(
  ctx: { resumeSessionId?: string; sessionContext?: SessionContextUsage },
  binding: SessionBinding | undefined,
): void {
  if (binding) ctx.resumeSessionId = binding.providerSessionId;
  else delete ctx.resumeSessionId;
  if (binding?.contextUsage) ctx.sessionContext = binding.contextUsage;
  else delete ctx.sessionContext;
}
