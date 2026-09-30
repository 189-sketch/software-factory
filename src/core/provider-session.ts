/**
 * Provider CLI session ledger (M6).
 *
 * Each pipeline role runs in its own git worktree, so the worktree is
 * the persistent filesystem context. On top of that the factory wants
 * to keep the model's own conversational memory alive across retry /
 * revision attempts — that means handing the next CLI spawn the
 * `--resume <session-id>` flag instead of paying cold-start cost and
 * losing prior tool-use history.
 *
 * `state.providerSessions[role]` holds the live binding. The factory
 * writes it from `StageRunResult.providerSessionId` after every stage
 * run and reads it from `StageRunRequest.resumeSessionId` before the
 * next one. Crash recovery works because the state is checkpointed
 * alongside every other durable field.
 *
 * This module mirrors `external-op-ledger.ts`: small pure helpers that
 * mutate `state` in place by returning a new array/object reference.
 * No I/O — the orchestrator's checkpoint write captures the change.
 */
import type { AgentBackend } from "../../runtime/agent-backends.d.mts";
import path from 'node:path';
import type { FactoryIssueState, ProviderSessionMap, SessionBinding } from "./types.js";

/** Inputs to `bindProviderSession`. */
export interface BindSessionInput {
  /** UUID returned by the CLI's `--output-format json` envelope
   * (`session_id` for Claude Code; the adapter normalizes backend-
   * specific field names into this single string). */
  providerSessionId: string;
  /** Backend that minted the session. */
  backend: AgentBackend;
  /** Model the session was started under; resume requires the same model. */
  model: string;
  workdir?: string;
  inputRevision?: string;
  /** ISO timestamp; defaults to now. */
  boundAt?: string;
  /** 1-based attempt number; defaults to previous binding + 1, or 1. */
  attempt?: number;
}

/**
 * Record (or replace) the live CLI session for `role`.
 *
 * One session per role: calling this twice with the same role
 * overwrites the previous binding (the CLI's auto-resume after a
 * restart returns the same id; the model-switch path returns a new
 * id and the old one is no longer reusable).
 *
 * Returns the new binding so callers can pass it straight to
 * `IssueStore.save`.
 */
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
  };
  const next: ProviderSessionMap = { ...(state.providerSessions ?? {}) };
  next[role] = binding;
  state.providerSessions = next;
  return binding;
}

/**
 * Return the live session for `role` if it can be safely resumed by
 * the requested backend + model, otherwise `undefined`.
 *
 * Cross-backend reuse is refused: a session minted by `claude-code`
 * cannot be resumed by `codex-cli`. A model switch inside the same
 * backend is also refused — the CLI itself rejects `--resume` when
 * the session's original model differs from the requested one, and
 * silently retrying the resume wastes a full spawn. In both cases the
 * caller should fall back to a cold start and (optionally) clear the
 * stale binding via `clearProviderSession`.
 */
export function getProviderSession(
  state: FactoryIssueState,
  role: string,
  requestedBackend: AgentBackend,
  requestedModel: string,
  requestedWorkdir?: string,
  requestedInputRevision?: string,
): SessionBinding | undefined {
  const binding = state.providerSessions?.[role];
  if (!binding) return undefined;
  if (binding.backend !== requestedBackend) return undefined;
  if (binding.model !== requestedModel) return undefined;
  if (requestedWorkdir && (!binding.workdir || path.resolve(binding.workdir) !== path.resolve(requestedWorkdir))) return undefined;
  if (requestedInputRevision && binding.inputRevision !== requestedInputRevision) return undefined;
  return binding;
}

/**
 * Drop the binding for `role`. Use after a `--resume` failure that
 * left the CLI unable to continue the previous session (corrupt
 * session file, schema drift after a CLI upgrade), or after an
 * explicit backend switch.
 */
export function clearProviderSession(state: FactoryIssueState, role: string): void {
  const current = state.providerSessions;
  if (!current || !(role in current)) return;
  const next: ProviderSessionMap = { ...current };
  delete next[role];
  state.providerSessions = next;
}

/**
 * Bind a resolved selection to `ctx.resumeSessionId` so the next
 * `dispatchAgentStage` call threads `--resume <id>` into the CLI.
 *
 * Pure read — does not mutate `state`. Use alongside
 * `captureProviderSession` after `agent.run()` to persist the new
 * binding produced by the run.
 */
export function attachResumeSessionId(
  ctx: { resumeSessionId?: string },
  binding: SessionBinding | undefined,
): void {
  if (binding) ctx.resumeSessionId = binding.providerSessionId;
  else delete ctx.resumeSessionId;
}
