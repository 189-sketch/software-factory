// runtime/typesafe-backend.mjs
//
// typesafe.ai HTTP backend adapter (Spec `2026-09-20-decision-architecture`
// Phase B / T8.1; wire contract corrected 2026-09-21).
//
// Sends one `POST https://api.typesafe.ai/v1/systemone` request per
// stage run, carrying a batch of primitive questions (choice / score /
// noul) over a shared `state`. Mirrors the
// `runClaudeCodeStageFromConfig` shape so the dispatcher can route
// through one of the two adapters without a special case.
//
// Request envelope (OFFICIAL System One contract —
// https://docs.typesafe.ai/api; the earlier `{model, state_hash,
// primitives}` shape was a project-local invention the real endpoint
// rejects with HTTP 400, and requirements.md §"Decision 2" never
// defined it — see the Erratum there):
//   {
//     model,                                  // jev-latest | jev-preview | jev-1.13.0
//     state,                                  // string | object | array, shared ONCE
//     questions: { <id>: { type, instructions, criteria? } },
//   }
// Response envelope:
//   { model, answers: { <id>: ... }, usage: { input_tokens, output_tokens } }
//
// The adapter maps official answers back into the internal
// `structuredOutput: [{id, value, confidence}]` legacy shape (see
// `mapAnswersToStructuredOutput`) so the per-agent parsers, verdict
// layer, decision router, and panel read model stay untouched.
//
// The `TYPESAFE_API_KEY` credential is carried in
// `Authorization: Bearer <key>` (NEVER in the body) so log readers /
// process listings never surface it.
//
// CJK Fallback Contract (requirements.md §"CJK Fallback Contract"):
// any of (a) network / 4xx / 5xx failure, (b) `TYPESAFE_API_KEY`
// missing, (c) `FACTORY_TYPESAFE_OFF=1` short-circuits the adapter to
// a synthetic `StageRunResult` with
//   - status: "failed"
//   - warnings: ["typesafe_fallback_to_claude: <reason>"]
//   - retryable: false
//   - providerSessionId: null
// `retryable: false` is contractual: until Phase 11 Slice F lands
// (`FACTORY_AGENT_BACKEND_FALLBACK` opt-in), the orchestrator does NOT
// auto-re-run on Claude; the calling stage surfaces the fallback in
// its summary.
//
// The adapter never logs the API key. The `api_key` field on
// `TypesafeRequest` exists for type completeness but is stripped from
// the body before serialisation.

import { agentWorkerEnvironment } from "./agent-backends.mjs";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 30_000;

// Official System One model names (https://docs.typesafe.ai/models).
// `jev-fast` and bare `jev` NEVER existed upstream — they were invented
// alongside the fake envelope and 400 with "Unknown model". The
// normalisation map keeps a stale `FACTORY_TYPESAFE_MODEL=jev-fast` in
// an operator .env from taking the whole judgment layer down.
const VALID_MODELS = Object.freeze(new Set(["jev-latest", "jev-preview", "jev-1.13.0"]));
const LEGACY_MODEL_MAP = Object.freeze({ "jev-fast": "jev-latest", "jev": "jev-latest" });
const DEFAULT_MODEL = "jev-latest";

/**
 * Map legacy/unknown model aliases onto a valid official model name.
 * Returns `[model, normalised]` where `normalised` is true when the
 * caller's value was rewritten (success path appends a
 * `model_alias_normalised: <old> -> <new>` warning; the warning
 * deliberately does NOT carry the contractual fallback prefix).
 *
 * @param {string | undefined} requested
 * @returns {[string, boolean]}
 */
function normaliseModel(requested) {
    const raw = typeof requested === "string" && requested.trim() ? requested.trim() : "";
    if (!raw) return [DEFAULT_MODEL, true];
    if (VALID_MODELS.has(raw)) return [raw, false];
    const mapped = LEGACY_MODEL_MAP[raw];
    if (mapped) return [mapped, true];
    // Unknown name: send as-is and let the API decide (a future alias
    // must not be silently downgraded); the 400 lands in the fallback
    // envelope with the upstream status.
    return [raw, false];
}

/**
 * @typedef {Object} TypesafeQuestion
 * @property {"noul" | "choice" | "score"} type
 * @property {string | Record<string, unknown> | unknown[]} instructions
 * @property {unknown} [criteria]
 *
 * @typedef {Object} TypesafeRequest
 * @property {string} model
 * @property {string | Record<string, unknown> | unknown[]} state
 * @property {Record<string, TypesafeQuestion>} questions
 * @property {string} [api_key]        // never logged; never sent in body
 *
 * @typedef {Object} TypesafeResponse
 * @property {string} [model]
 * @property {Record<string, { type: string } & Record<string, unknown>>} answers
 * @property {{ input_tokens?: number, output_tokens?: number }} [usage]
 * @property {string} [session_id]     // not official; kept for old recordings
 *
 * @typedef {Object} TypesafeStructuredEntry
 * @property {string} id
 * @property {unknown} value
 * @property {number} confidence
 */

/**
 * Build the synthetic fallback envelope required by requirements.md
 * §"CJK Fallback Contract". One helper keeps the three trigger
 * conditions identical — `FACTORY_TYPESAFE_OFF=1`, missing API key,
 * and any HTTP failure share the same shape and the same warning
 * prefix.
 *
 * @param {string} reason
 * @returns {{
 *   status: "failed",
 *   output: string,
 *   usage: null,
 *   logTail: string,
 *   backend: "typesafe",
 *   warnings: string[],
 *   retryable: false,
 *   providerSessionId: null,
 * }}
 */
function fallbackResult(reason) {
    return {
        status: "failed",
        output: "",
        usage: null,
        logTail: reason,
        backend: "typesafe",
        warnings: [`typesafe_fallback_to_claude: ${reason}`],
        retryable: false,
        providerSessionId: null,
    };
}

/**
 * True when `FACTORY_TYPESAFE_OFF=1` is set in env. The toggle is the
 * documented offline-testing escape hatch — every typesafe call
 * short-circuits to the fallback envelope regardless of API health.
 *
 * Only the literal string "1" is honoured; an empty value, "true", or
 * "yes" is ignored so an operator cannot accidentally route every
 * typesafe call to the fallback by exporting a bash boolean.
 */
function typesafeDisabled(env) {
    const raw = String(
        env?.FACTORY_TYPESAFE_OFF ?? process.env.FACTORY_TYPESAFE_OFF ?? "",
    ).trim().toLowerCase();
    return raw === "1";
}

/**
 * Send one POST to `api.typesafe.ai/v1/systemone` and parse the
 * JSON response.
 *
 * Three failure modes are mapped to the fallback envelope before
 * they escape:
 *
 *   - `fetch` throwing (network / DNS / TLS) → fallback
 *   - non-2xx HTTP status → fallback
 *   - non-JSON body → fallback
 *
 * `AbortSignal.any` lets a caller-supplied abort signal cancel the
 * in-flight request without the adapter having to thread a separate
 * timer. The combined signal also fires on the timeout (default 30 s)
 * so a stalled typesafe.ai endpoint never pins the worker.
 *
 * @param {TypesafeRequest} request
 * @param {string | undefined} apiKey
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   abortSignal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<TypesafeResponse>}
 */
async function postSystemOne(request, apiKey, opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new Error("fetch is not available; pass fetchImpl to runTypesafeStageFromConfig");
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (opts.abortSignal) signals.push(opts.abortSignal);
    const signal = AbortSignal.any(signals);

    // Strip `api_key` from the body even though the caller may have
    // set it (the type allows it for completeness). The header is the
    // only channel the key travels on.
    const { api_key: _ignored, ...body } = request;
    void _ignored;

    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetchImpl(TYPESAFE_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        // Surface the upstream status in the warning so the operator
        // can tell a 401 (key revoked) from a 429 (rate limit) from a
        // 500 (upstream outage).
        throw new Error(`http ${response.status} ${response.statusText}`.trim());
    }

    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`response is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response is not a JSON object");
    }
    return /** @type {TypesafeResponse} */ (parsed);
}

/**
 * Look up `decisions.decisions[*]` for the entry whose `action` matches
 * the supplied key. Returns `undefined` when the input is missing or
 * malformed; the caller MUST tolerate that (the confidence fallback is
 * a per-action gate, not a hard contract).
 *
 * @param {unknown} decisions
 * @param {string | undefined} action
 */
function findDecisionRule(decisions, action) {
    if (!decisions || typeof decisions !== "object") return undefined;
    const list = (decisions).decisions;
    if (!Array.isArray(list)) return undefined;
    if (typeof action !== "string" || !action) return undefined;
    for (const entry of list) {
        if (entry && typeof entry === "object" && entry.action === action) {
            return entry;
        }
    }
    return undefined;
}

/**
 * Clamp a finite number to 0..1; anything else → null.
 * @param {unknown} n
 */
function unitInterval(n) {
    return typeof n === "number" && Number.isFinite(n)
        ? Math.min(1, Math.max(0, n))
        : null;
}

/**
 * Map ONE official answer into the internal `{id, value, confidence}`
 * entry consumed by the per-agent parsers.
 *
 *   - noul   → value: boolean (probability >= 0.5), confidence: the
 *              noul probability itself. Official noul answers carry NO
 *              confidence field; existing readers (triage
 *              `noulYesFromPrimitives`, freshness `callTypesafeNoul`)
 *              read the probability from the confidence channel, so
 *              this mapping preserves their semantics exactly.
 *   - choice → value: chosen option key, confidence: official.
 *   - score  → value: 0..1 weighted score, confidence: official.
 *   - missing / malformed / unknown type → `{value: null, confidence: 0}`
 *     (parser typeof-validation drops the entry; a missing gate head
 *     conservatively trips the confidence fallback since 0 < any
 *     positive threshold).
 *
 * @param {string} id
 * @param {unknown} answer
 * @returns {TypesafeStructuredEntry}
 */
function mapOneAnswer(id, answer) {
    if (!answer || typeof answer !== "object") {
        return { id, value: null, confidence: 0 };
    }
    const a = /** @type {{ type?: unknown } & Record<string, unknown>} */ (answer);
    switch (a.type) {
        case "noul": {
            const n = unitInterval(a.noul);
            return n === null
                ? { id, value: null, confidence: 0 }
                : { id, value: n >= 0.5, confidence: n };
        }
        case "choice": {
            if (typeof a.choice !== "string") return { id, value: null, confidence: 0 };
            return { id, value: a.choice, confidence: unitInterval(a.confidence) ?? 0 };
        }
        case "score": {
            const s = unitInterval(a.score);
            if (s === null) return { id, value: null, confidence: 0 };
            return { id, value: s, confidence: unitInterval(a.confidence) ?? 0 };
        }
        default:
            return { id, value: null, confidence: 0 };
    }
}

/**
 * Map the official `answers` object into the internal structured-output
 * array. Iterates in REQUEST order (`Object.keys(questions)`) — not
 * answer-map order — so the confidence-gate head is deterministically
 * the first requested question, and integer-like keys cannot be
 * reordered by JS object semantics. Extra answer ids that were never
 * requested are ignored.
 *
 * @param {TypesafeRequest} request
 * @param {TypesafeResponse} response
 * @returns {TypesafeStructuredEntry[]}
 */
function mapAnswersToStructuredOutput(request, response) {
    const answers =
        response && typeof response.answers === "object" && response.answers !== null
            ? response.answers
            : {};
    const ids = Object.keys(request?.questions ?? {});
    return ids.map((id) => mapOneAnswer(id, answers[id]));
}

/**
 * Map the official `usage` object into the `StageRunResult.usage`
 * shape (`{inputTokens, outputTokens}`, each `number | null`). Missing
 * usage stays `null` — "absent ≠ zero" is the documented
 * StageRunResult contract (src/core/agent-runtime.ts).
 *
 * @param {TypesafeResponse["usage"]} usage
 */
function mapUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
    };
}

/**
 * Run a single typesafe.ai stage via the runtime backend configuration.
 *
 * Mirrors `runClaudeCodeStageFromConfig` (claude-code-backend.mjs):
 *
 *   - `config` is the resolved `AgentConfig` (used for env forwarding
 *     and `timeoutMs`).
 *   - `executable` is unused — typesafe speaks HTTP — but is kept on
 *     the signature so every backend-from-config helper has the same
 *     shape.
 *   - `request` is the typed envelope from
 *     `runtime/typesafe-backend.d.mts`.
 *   - `opts.abortSignal` is merged with the timeout so cancel
 *     propagation works.
 *
 * On any of `FACTORY_TYPESAFE_OFF=1`, missing `TYPESAFE_API_KEY`,
 * network failure, 4xx / 5xx, timeout, non-JSON response, or
 * `structuredOutput[0].confidence < decisions.yaml[<action>].escalate.confidence_max`,
 * the adapter returns the synthetic fallback envelope documented in
 * `requirements.md` §"CJK Fallback Contract". The fallback warning
 * prefix `typesafe_fallback_to_claude:` is contractual — the panel
 * read-model (Phase D) matches on it to render the fallback badge.
 *
 * The confidence check is **only** applied when the caller supplies
 * both `opts.action` (the `decisions.yaml` action key) and
 * `opts.decisions` (the parsed `DecisionsFile`). When either is
 * missing, the adapter behaves exactly like T8.1 (no per-action
 * gate). The wiring of `opts.action` / `opts.decisions` is the
 * orchestrator's job; the adapter stays a pure HTTP envelope.
 *
 * On success the adapter returns
 *   - status: "succeeded"
 *   - structuredOutput: official `answers` mapped into the internal
 *     `[{id, value, confidence}]` shape in REQUEST order (see
 *     `mapAnswersToStructuredOutput`)
 *   - usage: `{inputTokens, outputTokens}` from the official usage
 *     object, or null when absent
 *   - providerSessionId: response.session_id ?? null (the official
 *     contract has no session concept; real responses yield null)
 *   - warnings: [] unless the model alias was normalised, in which
 *     case `model_alias_normalised: <old> -> <new>` is appended (this
 *     warning deliberately lacks the fallback prefix).
 *
 * @param {import("./agent-backends.mjs").AgentConfig} config
 * @param {string} executable Unused for typesafe; kept for backend-shape symmetry.
 * @param {TypesafeRequest} request
 * @param {{ env?: NodeJS.ProcessEnv, abortSignal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number, action?: string, decisions?: unknown }} [opts]
 */
export async function runTypesafeStageFromConfig(config, executable, request, opts = {}) {
    // `executable` is unused; the parameter exists so the helper has
    // the same shape as `runClaudeCodeStageFromConfig`. Mark it
    // intentionally unused so a future change cannot drift the call
    // sites silently.
    void executable;

    const env = opts.env ?? agentWorkerEnvironment(process.env, config);

    // Honour FACTORY_TYPESAFE_OFF=1 before anything else. The toggle
    // is the documented offline-testing escape hatch — short-circuit
    // to the fallback envelope regardless of API health so CI / smoke
    // tests never depend on api.typesafe.ai being reachable.
    if (typesafeDisabled(env)) {
        return fallbackResult("FACTORY_TYPESAFE_OFF=1");
    }

    // Pull the API key out of the credential whitelist (forwarded
    // unconditionally by `agentWorkerEnvironment` — the typesafe
    // verdict layer is a bypass judgment call, not a per-role
    // backend). We never log `apiKey` — `process.env` access by name
    // alone is fine because nothing in the success / failure branches
    // echoes the value back.
    const apiKey = typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim()
        ? env.TYPESAFE_API_KEY.trim()
        : null;

    if (!apiKey) {
        return fallbackResult("TYPESAFE_API_KEY missing");
    }

    // The body never carries the key (see `postSystemOne`). Keeping
    // the variable separate from the envelope ensures a future code
    // change cannot accidentally move the key into the body.
    // `normaliseModel` rewrites legacy aliases (jev-fast / jev →
    // jev-latest) so a stale FACTORY_TYPESAFE_MODEL cannot 400 the
    // whole judgment layer.
    const [model, modelNormalised] = normaliseModel(request?.model);
    const sanitisedRequest = { ...request, model };
    delete sanitisedRequest.api_key;

    try {
        const response = await postSystemOne(sanitisedRequest, apiKey, {
            fetchImpl: opts.fetchImpl,
            timeoutMs: opts.timeoutMs ?? config.timeoutMs,
            abortSignal: opts.abortSignal,
        });
        // Map the official `answers` object into the internal
        // `[{id, value, confidence}]` shape in REQUEST order. `value`
        // is intentionally `unknown` here; the per-agent parser
        // validates the typed shape.
        const primitives = mapAnswersToStructuredOutput(sanitisedRequest, response);
        const sessionId = typeof response.session_id === "string" && response.session_id.trim()
            ? response.session_id.trim()
            : null;
        const usage = mapUsage(response.usage);

        // CJK fallback trigger 3 — per-action confidence below the
        // `decisions.yaml[<action>].escalate.confidence_max` threshold.
        // The check is opt-in (caller must supply both `action` and
        // `decisions`); without them no per-action gate runs. The gate
        // head is the mapped entry of the FIRST requested question.
        if (primitives.length > 0) {
            const rule = findDecisionRule(opts.decisions, opts.action);
            const threshold = rule?.escalate?.confidence_max;
            const head = primitives[0];
            if (
                typeof threshold === "number"
                && head
                && typeof head === "object"
                && typeof head.confidence === "number"
                && head.confidence < threshold
            ) {
                return fallbackResult(
                    `confidence ${head.confidence} below ${threshold} for ${opts.action}`,
                );
            }
        }

        return {
            status: "succeeded",
            output: "",
            usage,
            logTail: "",
            backend: "typesafe",
            warnings: modelNormalised
                ? [`model_alias_normalised: ${String(request?.model ?? "").trim() || "<empty>"} -> ${model}`]
                : [],
            retryable: false,
            providerSessionId: sessionId,
            structuredOutput: primitives,
        };
    } catch (error) {
        // The contract is `retryable: false` regardless of cause —
        // a transient retry would just repeat the same failure. The
        // reason is surfaced verbatim in the warning so log readers
        // can distinguish `http 401` from `http 429` from a timeout.
        const reason = (error instanceof Error ? error.message : String(error)).trim() || "unknown error";
        return fallbackResult(reason);
    }
}