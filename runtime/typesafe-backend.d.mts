/**
 * typesafe.ai HTTP backend adapter — TypeScript declarations.
 * See `typesafe-backend.mjs` for the runtime contract and
 * `specs/2026-09-20-decision-architecture/requirements.md` §"CJK Fallback
 * Contract" for the fallback envelope.
 *
 * Wire contract (2026-09-21 erratum): the request/response shapes below
 * follow the OFFICIAL System One API documented at
 * https://docs.typesafe.ai/api — `{model, state, questions}` →
 * `{model, answers, usage}`. The earlier `{model, state_hash,
 * primitives}` envelope was a project-local invention that the real
 * endpoint rejects with HTTP 400; requirements.md §"Decision 2" never
 * defined it (see the Erratum there).
 */
import type { AgentConfig } from "./agent-backends.d.mts";
import type { StageRunResult } from "../src/core/agent-runtime.js";

/** Official System One question types. */
export type TypesafeQuestionType = "noul" | "choice" | "score";

/**
 * `instructions` / `criteria` accept a plain string or structured JSON
 * (official: string | object | array). Reference nested `state` fields
 * with backticked dot-and-index paths, e.g. `issue.comments[0].body`.
 */
export type TypesafeInstructions = string | Record<string, unknown> | unknown[];

/**
 * A yes/no judgment. The answer is the probability that the condition
 * holds; there is NO separate confidence. `criteria` optionally
 * clarifies what `true` / `false` mean.
 */
export interface TypesafeNoulQuestion {
    type: "noul";
    instructions: TypesafeInstructions;
    criteria?: { true?: string; false?: string };
}

/**
 * One-of-N selection. `criteria` is REQUIRED: a map of option key →
 * description (or null); at most 255 options. The answer carries the
 * chosen key, the full probability distribution, and a confidence
 * (distribution concentration).
 */
export interface TypesafeChoiceQuestion {
    type: "choice";
    instructions: TypesafeInstructions;
    criteria: Record<string, string | null>;
}

/**
 * Degree along a described dimension. `criteria` is REQUIRED: an
 * ordered array of 2–10 level descriptions. The answer is the
 * probability-weighted position normalised to 0..1, plus the legend,
 * per-level probabilities, and confidence.
 */
export interface TypesafeScoreQuestion {
    type: "score";
    instructions: TypesafeInstructions;
    criteria: string[];
}

export type TypesafeQuestion =
    | TypesafeNoulQuestion
    | TypesafeChoiceQuestion
    | TypesafeScoreQuestion;

/**
 * Wire envelope posted to `https://api.typesafe.ai/v1/systemone`.
 *
 * `state` is shared ONCE across the whole batch (string | object |
 * array) — questions reference it via backticked paths in their
 * `instructions`. Question ids are for code only (not sent to the
 * model); `answers` is keyed by the same ids.
 *
 * `model` must be one of `jev-latest` / `jev-preview` / `jev-1.13.0`.
 * Legacy project aliases (`jev-fast`, `jev`) are normalised to
 * `jev-latest` by the adapter (with a `model_alias_normalised`
 * warning) so a stale `FACTORY_TYPESAFE_MODEL` in an operator .env
 * cannot 400 the whole judgment layer.
 *
 * `api_key` is never included in the body — the adapter carries it in
 * the `Authorization: Bearer` header instead.
 */
export interface TypesafeRequest {
    model: string;
    state: string | object | unknown[];
    questions: Record<string, TypesafeQuestion>;
    /** Present in the type for completeness; stripped before send, never logged. */
    api_key?: string;
}

/** Official noul answer: the probability that the condition holds. */
export interface TypesafeNoulAnswer {
    type: "noul";
    noul: number;
}

/** Official choice answer. */
export interface TypesafeChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}

/** Official score answer (`score` is normalised to 0..1). */
export interface TypesafeScoreAnswer {
    type: "score";
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}

export type TypesafeAnswer =
    | TypesafeNoulAnswer
    | TypesafeChoiceAnswer
    | TypesafeScoreAnswer;

/**
 * Response envelope from the typesafe.ai endpoint.
 *
 * `session_id` is NOT part of the official contract; the adapter still
 * reads it when present so old recordings / replays and test mocks
 * keep working. `providerSessionId` is null for real responses.
 */
export interface TypesafeResponse {
    model?: string;
    answers: Record<string, TypesafeAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
    session_id?: string;
}

/**
 * Internal structured-output entry — the contract between the adapter
 * and the per-agent parsers. The adapter maps official answers into
 * this legacy `{id, value, confidence}` shape so downstream parsers,
 * spec-verdict, decision-router, and the control-panel read model are
 * untouched:
 *
 *   - noul   → value: boolean (noul >= 0.5), confidence: the noul
 *              probability itself (official noul has no confidence;
 *              existing readers — triage `noulYesFromPrimitives`,
 *              freshness `callTypesafeNoul` — read the probability
 *              from the confidence channel).
 *   - choice → value: chosen option key (string), confidence: official.
 *   - score  → value: 0..1 (number), confidence: official.
 *   - missing / malformed / unknown type → value: null, confidence: 0
 *              (per-agent typeof validation naturally drops the entry;
 *              a missing gate head conservatively trips the confidence
 *              fallback because 0 < any positive threshold).
 *
 * Entries are emitted in REQUEST order (`Object.keys(questions)`), not
 * answer-map order, so the confidence-gate head is deterministic.
 */
export interface TypesafeStructuredEntry {
    id: string;
    value: unknown;
    confidence: number;
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
 * (`structuredOutput[0].confidence < decisions.yaml[<action>].escalate.confidence_max`,
 * `requirements.md` §"CJK Fallback Contract" §1). The gate head is the
 * mapped entry of the FIRST question in request order. When either
 * field is omitted, no per-action gate runs. The dispatcher /
 * orchestrator wires both fields in (T9.x); the adapter stays a pure
 * HTTP envelope.
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
 *   - the mapped gate-head confidence falling below the opt-in
 *     `decisions.yaml[action].escalate.confidence_max` threshold,
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
