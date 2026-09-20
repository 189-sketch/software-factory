/**
 * typesafe.ai HTTP backend adapter — TypeScript declarations.
 * See `typesafe-backend.mjs` for the runtime contract and
 * `specs/2026-09-20-decision-architecture/requirements.md` §"CJK Fallback
 * Contract" for the fallback envelope.
 */
import type { AgentConfig } from "./agent-backends.d.mts";
import type { StageRunResult } from "../src/core/agent-runtime.js";
import type { JudgmentState } from "../src/core/judgment-state.js";

/**
 * One primitive question in the `systemone` batch.
 *
 * The spec calls for four primitive kinds — `Choice`, `Score`, `Noul`,
 * and `extraction`. Each carries the shared `JudgmentState` so a batch
 * call can fan out to many primitives while keeping them in lock-step
 * with the same `issue.updatedAt` / `comments.length` / `lastReceiptSha`.
 *
 * `state` is the `JudgmentState` shape from `src/core/judgment-state.ts`;
 * the adapter serialises it via JSON and the typesafe.ai endpoint hashes
 * it server-side to validate that the request is fresh.
 */
export interface TypesafePrimitive {
    id: string;
    type: "Choice" | "Score" | "Noul" | "extraction";
    question: string;
    state: JudgmentState;
}

/**
 * Wire envelope posted to `https://api.typesafe.ai/v1/systemone`.
 *
 * `state_hash` is the freshness hash from `stateHashFor(state)` in
 * `src/core/judgment-state.ts`; the typesafe.ai side echoes it back so
 * the orchestrator can correlate the response with the request that
 * produced it. `api_key` is never included in the body — the adapter
 * carries it in the `Authorization: Bearer` header instead.
 */
export interface TypesafeRequest {
    model: string;
    state_hash: string;
    primitives: TypesafePrimitive[];
    /** Present in the body for completeness; never logged. */
    api_key?: string;
}

/**
 * Response envelope from the typesafe.ai endpoint.
 *
 * `primitives[i].value` is opaque — the shape depends on the primitive
 * `type` (a `Choice` returns the chosen option, a `Score` returns a
 * numeric, a `Noul` returns a boolean). The adapter threads the raw
 * values through to `StageRunResult.structuredOutput`; the per-agent
 * parser validates the typed shape.
 *
 * `session_id` is the mock session id for Phase B (the real
 * `systemone` endpoint does not surface a session concept yet); the
 * adapter carries it through as `providerSessionId` so the dispatcher
 * can persist it on `FactoryIssueState.providerSessions`.
 */
export interface TypesafeResponse {
    primitives: Array<{ id: string; value: unknown; confidence: number }>;
    session_id?: string;
}

/**
 * Adapter options. `fetchImpl` is injected for tests so unit tests can
 * assert the request body without hitting the real `api.typesafe.ai`
 * endpoint. `timeoutMs` defaults to 30 000 (30 s) — typesafe calls are
 * short — and is combined with the caller's `abortSignal` so cancel
 * propagation works through `AbortSignal.any`.
 */
export interface TypesafeAdapterOptions {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/**
 * Options bag for `runTypesafeStageFromConfig`.
 *
 * `env` lets tests inject a closed environment without mutating
 * `process.env`; production callers leave it unset so the adapter
 * threads `process.env` through `agentWorkerEnvironment` and gets
 * the credential whitelist for free.
 *
 * `fetchImpl` lets tests substitute `fetch` so they do not have to
 * reach `api.typesafe.ai`.
 *
 * `timeoutMs` overrides the per-call timeout (default 30 000 ms);
 * the value is merged with `abortSignal` via `AbortSignal.any` so a
 * stalled typesafe.ai request never pins the worker.
 *
 * `action` + `decisions` are the **opt-in** confidence-gate hook
 * for the third CJK fallback trigger
 * (`primitives[0].confidence < decisions.yaml[<action>].escalate.confidence_max`,
 * `requirements.md` §"CJK Fallback Contract" §1). When either is
 * omitted, the adapter behaves exactly like T8.1 (no per-action
 * gate). The dispatcher / orchestrator wires both fields in
 * (T9.x); the adapter stays a pure HTTP envelope.
 */
export interface TypesafeStageOptions {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    /** `decisions.yaml` action key (e.g. `triage.apply_label`). Required, together with `decisions`, to enable the confidence fallback trigger. */
    action?: string;
    /** Parsed `DecisionsFile` (or any object with a `decisions: { action, escalate?: { confidence_max?: number } }[]` shape). */
    decisions?: unknown;
}

/**
 * Run a single typesafe.ai stage via the runtime backend configuration.
 *
 * Mirrors `runClaudeCodeStageFromConfig`: `executable` is unused for
 * typesafe (the adapter speaks HTTP, not a child process) but is kept
 * on the signature so every backend-from-config helper has the same
 * shape.
 *
 * On any of:
 *   - `FACTORY_TYPESAFE_OFF=1` set in env,
 *   - `TYPESAFE_API_KEY` missing,
 *   - the HTTP request returning 4xx / 5xx / timing out / returning
 *     non-JSON,
 * the adapter returns a synthetic `StageRunResult` with
 * `status: "failed"`, `warnings: ["typesafe_fallback_to_claude: <reason>"]`,
 * `retryable: false`, `providerSessionId: null` — the CJK fallback
 * envelope documented in `requirements.md` §"CJK Fallback Contract".
 */
export declare function runTypesafeStageFromConfig(
    config: AgentConfig,
    executable: string,
    request: TypesafeRequest,
    opts?: TypesafeStageOptions,
): Promise<StageRunResult>;