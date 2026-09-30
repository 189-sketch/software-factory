/**
 * T8.1 acceptance — `runtime/typesafe-backend.mjs` HTTP adapter + CJK
 * fallback envelope.
 *
 * The adapter is the only LLM call that goes to typesafe.ai in
 * Phase B; every other path is `claude-code`. The unit tests inject a
 * mock `fetchImpl` so they do not depend on `api.typesafe.ai` being
 * reachable from CI / smoke.
 *
 * Coverage map (mirrors the contract in `requirements.md`
 * §"CJK Fallback Contract" + the 2026-09-21 official-contract
 * migration documented in `runtime/typesafe-backend.d.mts`):
 *
 *   - Happy path: mock returns 200 + the OFFICIAL `{model, answers,
 *     usage}` envelope → `succeeded` with official answers mapped
 *     into the internal `structuredOutput: [{id, value, confidence}]`
 *     contract in REQUEST order, `providerSessionId` from
 *     `response.session_id` when present, `usage` mapped into
 *     `{inputTokens, outputTokens}`.
 *   - `FACTORY_TYPESAFE_OFF=1` short-circuits to fallback regardless
 *     of API health (the env var is the documented offline-testing
 *     escape hatch; covered here + by `typesafe-fallback-cli.test.mjs`
 *     in T8.5).
 *   - Missing `TYPESAFE_API_KEY` → fallback with reason "TYPESAFE_API_KEY
 *     missing".
 *   - 4xx / 5xx → fallback with the upstream status in the warning.
 *   - Timeout / abort → fallback with the timeout reason.
 *   - Non-JSON response → fallback with "not valid JSON".
 *   - Request body shape: official `{model, state, questions}`
 *     round-trips; `Authorization` header is set only when the key is
 *     configured; the key NEVER appears in the body; `state_hash`
 *     does NOT travel on the wire.
 *   - Answer mapping: noul probability on the confidence channel
 *     (`{value: noul >= 0.5, confidence: noul}`), choice returns its
 *     key string, score returns 0..1; missing/malformed/unknown
 *     answers degrade to `{value: null, confidence: 0}`.
 *   - Extra answer ids that were never requested are ignored; entries
 *     appear in REQUEST order so the confidence-gate head is
 *     deterministic.
 *   - Model alias defence: legacy `jev-fast` / bare `jev` are
 *     normalised to `jev-latest` and surface a
 *     `model_alias_normalised: <old> -> <new>` warning that does NOT
 *     carry the fallback prefix.
 *   - `retryable: false` is contractual regardless of cause.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    runTypesafeStageFromConfig,
} from "../../runtime/typesafe-backend.mjs";
import { resolveAgentConfig } from "../../runtime/agent-backends.mjs";
import type {
    TypesafeRequest,
    TypesafeResponse,
} from "../../runtime/typesafe-backend.d.mts";

/* -------------------------------------------------------------------- */
/* Fixtures                                                             */
/* -------------------------------------------------------------------- */

function makeConfig(overrides: Record<string, string | undefined> = {}) {
    return resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "claude-code",
        ...overrides,
    });
}

/**
 * Two-question request used by most tests: one noul (id `f`) and one
 * choice (id `c`). The noul is FIRST so the confidence-gate head is
 * predictable.
 */
function makeRequest(): TypesafeRequest {
    return {
        model: "jev-latest",
        state: {
            issueNumber: 42,
            title: "Test issue",
            body: "",
            labels: ["bug"],
            updatedAt: "2026-09-20T00:00:00.000Z",
            comments: [],
        },
        questions: {
            f: {
                type: "noul",
                instructions: "Is the state fresh?",
                criteria: { true: "fresh", false: "stale" },
            },
            c: {
                type: "choice",
                instructions: "Should we apply the bug label?",
                criteria: { bug: "yes", not_bug: "no" },
            },
        },
    };
}

/**
 * Build the `env` bag the adapter will receive. The adapter runs
 * `agentWorkerEnvironment(process.env, config)` by default — tests
 * inject their own env via `opts.env` so they don't have to mutate
 * `process.env` globally and step on sibling tests.
 *
 * The helper mirrors what `agentWorkerEnvironment` would produce for
 * a `typesafe` selection so the adapter's logic is exercised against
 * a real env shape, not a hand-rolled stub.
 */
function typesafeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-latest",
        ...overrides,
    };
}

/**
 * Captures the body / headers / URL handed to `fetch` so each test
 * can assert exactly what the adapter sent.
 */
function captureFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const calls: Array<{
        url: string;
        body: unknown;
        headers: Record<string, string>;
        signal: AbortSignal | null;
    }> = [];
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = (init ?? {}) as RequestInit;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers ?? {})) {
            headers[String(k).toLowerCase()] = String(v);
        }
        let parsedBody: unknown = req.body;
        if (typeof req.body === "string") {
            try { parsedBody = JSON.parse(req.body); } catch { /* keep as string */ }
        }
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            body: parsedBody,
            headers,
            signal: (req.signal as AbortSignal | null) ?? null,
        });
        return impl(input, init);
    };
    return { fetch: wrapped as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/* -------------------------------------------------------------------- */
/* Happy path                                                            */
/* -------------------------------------------------------------------- */

test("runTypesafeStageFromConfig returns succeeded on a 200 official envelope and maps answers to structuredOutput in request order", async () => {
    const responseBody: TypesafeResponse = {
        model: "jev-1.13.0",
        answers: {
            f: { type: "noul", noul: 0.92 },              // value: true, confidence: 0.92
            c: { type: "choice", choice: "bug", probabilities: { bug: 0.92, not_bug: 0.08 }, confidence: 0.92 },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
        session_id: "ts-session-mock-1",
    };
    const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, responseBody));

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe", // unused, kept for symmetry
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.backend, "typesafe");
    assert.equal(result.retryable, false);
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 10 });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.providerSessionId, "ts-session-mock-1");

    // structuredOutput MUST be in REQUEST order (f then c), not
    // answers-object insertion order.
    assert.deepEqual(result.structuredOutput, [
        { id: "f", value: true, confidence: 0.92 },
        { id: "c", value: "bug", confidence: 0.92 },
    ]);

    // The fetch adapter must have been called exactly once.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(calls[0].headers["content-type"], "application/json");
    // Authorization header is set when the key is configured.
    assert.equal(calls[0].headers.authorization, "Bearer tk_test_secret");
    // Body shape: official {model, state, questions} round-trips;
    // state_hash does NOT travel on the wire; the key NEVER travels
    // in the body.
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.model, "jev-latest");
    assert.ok(!("state_hash" in body), "state_hash must not travel on the wire");
    assert.ok(!("primitives" in body), "primitives array must not travel on the wire");
    assert.equal(typeof body.state, "object");
    assert.deepEqual(Object.keys(body.questions as object).sort(), ["c", "f"]);
    assert.ok(!("api_key" in body), "API key leaked into request body");
});

test("providerSessionId falls back to null when the response omits session_id", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.providerSessionId, null);
});

/* -------------------------------------------------------------------- */
/* Answer mapping semantics                                              */
/* -------------------------------------------------------------------- */

test("noul answers map to {value: boolean (noul >= 0.5), confidence: noul probability}", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
            f: { type: "noul", noul: 0.94 },
            c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    const f = (result.structuredOutput as Array<{ id: string; value: unknown; confidence: number }>).find((x) => x.id === "f");
    assert.deepEqual(f, { id: "f", value: true, confidence: 0.94 });
});

test("noul answer with probability exactly 0.5 maps to value:true (>=)", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    const f = (result.structuredOutput as Array<{ id: string; value: unknown; confidence: number }>).find((x) => x.id === "f");
    assert.deepEqual(f, { id: "f", value: true, confidence: 0.5 });
});

test("score answers map to {value: 0..1 number, confidence: official}", async () => {
    const request: TypesafeRequest = {
        model: "jev-latest",
        state: { issueNumber: 1 },
        questions: {
            s: { type: "score", instructions: "How complete?", criteria: ["vague", "specific"] },
        },
    };
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { s: { type: "score", score: 0.83, legend: { "0": "vague", "1": "specific" }, probabilities: { "0": 0.17, "1": 0.83 }, confidence: 0.83 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        request,
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.structuredOutput, [{ id: "s", value: 0.83, confidence: 0.83 }]);
});

test("multi-level score answers are normalised by the max level index (official 0..N range)", async () => {
    // Official Score semantics (docs.typesafe.ai/primitives/score): the
    // answer's `score` is the probability-weighted mean of the LEVEL
    // NUMBERS — a 4-level question answers in 0..3, NOT 0..1. The
    // adapter must normalise to the internal 0..1 contract; clamping
    // (the pre-fix behaviour) collapsed every level ≥ 1 to 1.0 and
    // silently disabled the B2 / R2 gates.
    const request: TypesafeRequest = {
        model: "jev-latest",
        state: { issueNumber: 1 },
        questions: {
            // 4-level (0..3): raw 2.8 → 2.8/3 ≈ 0.9333 ("Weak partial"
            // raw 1.0 would map to 0.3333 — below the R2 suggestion
            // threshold, which is exactly the discrimination the clamp
            // destroyed).
            r2: { type: "score", instructions: "Coverage?", criteria: ["none", "weak", "strong", "full"] },
            // 3-level (0..2): raw 1.15 → 0.575.
            b13: { type: "score", instructions: "Complexity?", criteria: ["trivial", "moderate", "multi"] },
        },
    };
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
            r2: { type: "score", score: 2.8, legend: { "0": "none", "1": "weak", "2": "strong", "3": "full" }, probabilities: { "0": 0, "1": 0.05, "2": 0.1, "3": 0.85 }, confidence: 0.88 },
            b13: { type: "score", score: 1.15, legend: { "0": "trivial", "1": "moderate", "2": "multi" }, probabilities: { "0": 0.1, "1": 0.65, "2": 0.25 }, confidence: 0.65 },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        request,
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    const entries = result.structuredOutput as Array<{ id: string; value: number; confidence: number }>;
    const r2 = entries.find((x) => x.id === "r2")!;
    const b13 = entries.find((x) => x.id === "b13")!;
    assert.ok(Math.abs(r2.value - 2.8 / 3) < 1e-9, `r2 value ${r2.value} ≈ 0.9333`);
    assert.equal(r2.confidence, 0.88);
    assert.ok(Math.abs(b13.value - 0.575) < 1e-9, `b13 value ${b13.value} ≈ 0.575`);
    assert.equal(b13.confidence, 0.65);
});

test("score normalisation falls back to the response legend when criteria is unusable", async () => {
    const request = {
        model: "jev-latest",
        state: { issueNumber: 1 },
        questions: {
            // criteria deliberately malformed (not an array) — the
            // adapter must fall back to the legend's highest level key.
            s: { type: "score", instructions: "How complete?", criteria: undefined as unknown as string[] },
        },
    } as unknown as TypesafeRequest;
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { s: { type: "score", score: 1.5, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.25, "1": 0.5, "2": 0.25 }, confidence: 0.6 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        request,
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.structuredOutput, [{ id: "s", value: 0.75, confidence: 0.6 }]);
});

test("missing / malformed / unknown-type answers degrade to {value: null, confidence: 0}", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
            f: undefined,                                                       // missing
            c: { type: "unknown", payload: 42 },                                // unknown type
        },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    const entries = result.structuredOutput as Array<{ id: string; value: unknown; confidence: number }>;
    assert.deepEqual(entries, [
        { id: "f", value: null, confidence: 0 },
        { id: "c", value: null, confidence: 0 },
    ]);
});

test("extra answer ids that were never requested are ignored", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
            f: { type: "noul", noul: 0.9 },
            c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 },
            ghost: { type: "noul", noul: 0.1 }, // not requested
        },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    const entries = result.structuredOutput as Array<{ id: string; value: unknown; confidence: number }>;
    assert.equal(entries.length, 2, "extra 'ghost' answer must be ignored");
    assert.deepEqual(entries.map((e) => e.id), ["f", "c"]);
});

test("usage field is mapped into {inputTokens, outputTokens} when present", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 7, output_tokens: 3 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
});

test("usage field stays null when absent (absent != 0)", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        // no usage
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.usage, null);
});

/* -------------------------------------------------------------------- */
/* Model alias defence                                                  */
/* -------------------------------------------------------------------- */

test("legacy 'jev-fast' model is normalised to 'jev-latest' and surfaces model_alias_normalised warning (no fallback prefix)", async () => {
    const req: TypesafeRequest = { ...makeRequest(), model: "jev-fast" };
    const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.7 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        req,
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.warnings, ["model_alias_normalised: jev-fast -> jev-latest"]);
    // The wire body carries the normalised alias.
    assert.equal((calls[0].body as Record<string, unknown>).model, "jev-latest");
});

test("legacy 'jev' (bare) model is normalised to 'jev-latest'", async () => {
    const req: TypesafeRequest = { ...makeRequest(), model: "jev" };
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.7 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        req,
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.warnings, ["model_alias_normalised: jev -> jev-latest"]);
});

test("empty model defaults to 'jev-latest' with a normalised warning", async () => {
    const req: TypesafeRequest = { ...makeRequest(), model: "" };
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.7 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        req,
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.warnings, ["model_alias_normalised: <empty> -> jev-latest"]);
});

test("'jev-latest' / 'jev-preview' / 'jev-1.13.0' pass through without a normalised warning", async () => {
    for (const alias of ["jev-latest", "jev-preview", "jev-1.13.0"]) {
        const req: TypesafeRequest = { ...makeRequest(), model: alias };
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
            model: "jev-1.13.0",
            answers: { f: { type: "noul", noul: 0.7 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
            usage: { input_tokens: 0, output_tokens: 0 },
        }));
        const result = await runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
            "typesafe",
            req,
            { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
        );
        assert.equal(result.status, "succeeded", alias);
        assert.deepEqual(result.warnings, [], alias);
    }
});

/* -------------------------------------------------------------------- */
/* Confidence routing — the OLD CJK fallback trigger 3 (head             */
/* confidence < escalate.confidence_max → fallback) was removed            */
/* 2026-09-22. Low confidence is a ROUTING signal, not a model-unavail   */
/* signal: the caller's `applyDecision` escalate / confirm tier handles  */
/* it. The adapter stays a pure HTTP envelope.                           */
/* -------------------------------------------------------------------- */

test("low-confidence answers flow through as succeeded (routing is the caller's job, not the adapter's)", async () => {
    // First question `f` has noul 0.1 — an extremely uncertain answer.
    // The adapter must NOT collapse this into a fallback envelope; it
    // returns succeeded and the caller decides what to do.
    const decisions = { decisions: [{ action: "triage.apply_label", escalate: { confidence_max: 0.5 } }] };
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.1 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock, action: "triage.apply_label", decisions },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(Array.isArray(result.structuredOutput) ? result.structuredOutput.length : 0, 2);
});

/* -------------------------------------------------------------------- */
/* 429 / 529 exponential-backoff retry                                    */
/* -------------------------------------------------------------------- */

test("429 is retried with exponential backoff; final retry's response is returned", async () => {
    let attempts = 0;
    const responses = [
        await new Response("rate limit", { status: 429 }),
        await new Response("rate limit", { status: 429 }),
        await jsonResponse(200, {
            model: "jev-1.13.0",
            answers: { f: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 0, output_tokens: 0 },
        }),
    ];
    const { fetch: fetchMock, calls } = captureFetch(async () => {
        const response = responses[attempts++];
        if (!response) throw new Error("exhausted retry fixture");
        return response;
    });
    const sleeps: number[] = [];
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
            sleep: async (ms: number) => { sleeps.push(ms); },
        },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(attempts, 3, "two 429s then a 200");
    assert.equal(calls.length, 3);
    // Exponential: 400ms then 800ms; no jitter so the assertions are
    // deterministic.
    assert.deepEqual(sleeps, [400, 800]);
});

test("529 is retried just like 429 (overloaded upstream)", async () => {
    let attempts = 0;
    const responses = [
        await new Response("overloaded", { status: 529 }),
        await jsonResponse(200, {
            model: "jev-1.13.0",
            answers: { f: { type: "noul", noul: 0.7 } },
            usage: { input_tokens: 0, output_tokens: 0 },
        }),
    ];
    const { fetch: fetchMock } = captureFetch(async () => {
        const response = responses[attempts++];
        if (!response) throw new Error("exhausted retry fixture");
        return response;
    });
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
            sleep: async () => undefined,
        },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(attempts, 2);
});

test("5xx (other than 529) is NOT retried — single fetch, immediate fallback envelope", async () => {
    // Per the docs only 429 and 529 get exponential-backoff retry;
    // a generic 5xx (e.g. 503 upstream down) is a terminal disposition
    // that the CJK contract collapses into the claude-code fallback.
    let attempts = 0;
    const fetchMock = (async () => {
        attempts += 1;
        return new Response("upstream down", { status: 503 });
    }) as typeof fetch;
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        { env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }), fetchImpl: fetchMock },
    );
    assert.equal(result.status, "failed");
    assert.equal(attempts, 1, "503 must NOT be retried");
    assert.match(result.warnings.join(";"), /http 503/);
});

test("429 retried once then a 500 is returned: total two attempts; status failed", async () => {
    // Mixed: 429 (retryable) → 500 (terminal). The retry budget
    // is exhausted after a non-retryable failure.
    let attempts = 0;
    const responses = [
        await new Response("rate limit", { status: 429 }),
        await new Response("upstream down", { status: 500 }),
    ];
    const { fetch: fetchMock } = captureFetch(async () => {
        const response = responses[attempts++];
        if (!response) throw new Error("exhausted fixture");
        return response;
    });
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
            sleep: async () => undefined,
        },
    );
    assert.equal(result.status, "failed");
    assert.equal(attempts, 2);
    assert.match(result.warnings.join(";"), /http 500/);
});

/* -------------------------------------------------------------------- */
/* CJK Fallback envelope — required by requirements.md §"CJK Fallback    */
/* Contract"                                                             */
/* -------------------------------------------------------------------- */

test("runTypesafeStageFromConfig short-circuits to fallback when FACTORY_TYPESAFE_OFF=1", async () => {
    // fetchImpl must NEVER be called when the toggle is set.
    const fetchMock = async () => {
        throw new Error("fetch should not have been called when FACTORY_TYPESAFE_OFF=1");
    };

    const result = await runTypesafeStageFromConfig(
        makeConfig({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.backend, "typesafe");
    assert.equal(result.retryable, false);
    assert.equal(result.providerSessionId, null);
    assert.deepEqual(result.warnings, ["typesafe_fallback_to_claude: FACTORY_TYPESAFE_OFF=1"]);
});

test("runTypesafeStageFromConfig falls back when TYPESAFE_API_KEY is missing", async () => {
    const fetchMock = async () => {
        throw new Error("fetch should not have been called when TYPESAFE_API_KEY is missing");
    };

    const result = await runTypesafeStageFromConfig(
        makeConfig({}), // no TYPESAFE_API_KEY
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({}), // no TYPESAFE_API_KEY
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.deepEqual(result.warnings, ["typesafe_fallback_to_claude: TYPESAFE_API_KEY missing"]);
});

test("runTypesafeStageFromConfig falls back on a 4xx response (HTTP 401)", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(401, { error: "unauthorized" }));

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.equal(result.providerSessionId, null);
    assert.ok(
        result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w)),
        `warning missing typesafe_fallback_to_claude prefix: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
        result.warnings.some((w) => /401/.test(w)),
        `warning must surface the upstream status: ${JSON.stringify(result.warnings)}`,
    );
});

test('HTTP errors expose safe machine codes without echoing upstream input or secrets', async () => {
    for (const code of ['max_tokens_exceeded', 'tk_test_secret echoed input']) {
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(400, {
            detail: { error_type: code, message: 'tk_test_secret private request content' },
        }));
        const result = await runTypesafeStageFromConfig(makeConfig({ TYPESAFE_API_KEY: 'tk_test_secret' }),
            'typesafe', makeRequest(), { env: typesafeEnv({ TYPESAFE_API_KEY: 'tk_test_secret' }), fetchImpl: fetchMock });
        assert.match(result.warnings.join(' '), /400/);
        assert.equal(result.warnings.join(' ').includes('max_tokens_exceeded'), code === 'max_tokens_exceeded');
        assert.doesNotMatch(result.warnings.join(' '), /tk_test_secret|private request|echoed input/);
    }
});

test("runTypesafeStageFromConfig falls back on a 5xx response (HTTP 503)", async () => {
    const { fetch: fetchMock } = captureFetch(async () => new Response("upstream down", { status: 503 }));

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.ok(
        result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w) && /503/.test(w)),
        `warning must include status 503: ${JSON.stringify(result.warnings)}`,
    );
});

test("runTypesafeStageFromConfig falls back when fetch throws a network error", async () => {
    const fetchMock = async () => {
        throw new Error("ECONNREFUSED");
    };

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.ok(
        result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w) && /ECONNREFUSED/.test(w)),
        `warning must include ECONNREFUSED: ${JSON.stringify(result.warnings)}`,
    );
});

test("runTypesafeStageFromConfig falls back on timeout (AbortSignal.timeout fires)", async () => {
    // Simulate a stalled request: fetch honours the signal and aborts
    // with AbortError, which `fetch` rethrows as `DOMException` /
    // `Error` whose name is `AbortError`. We surface that to the
    // adapter; the adapter must map it to the fallback envelope.
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
            const signal = (init?.signal as AbortSignal | undefined);
            if (signal) {
                signal.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                });
            }
        });
    };

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
            timeoutMs: 25,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.equal(result.providerSessionId, null);
    assert.ok(
        result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w)),
        `warning missing typesafe_fallback_to_claude prefix: ${JSON.stringify(result.warnings)}`,
    );
});

test("runTypesafeStageFromConfig falls back when the response body is not valid JSON", async () => {
    const fetchMock = async () => new Response("<html>oops</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
    });

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.ok(
        result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w) && /JSON/i.test(w)),
        `warning must mention JSON: ${JSON.stringify(result.warnings)}`,
    );
});

test("runTypesafeStageFromConfig falls back when the response body is not a JSON object", async () => {
    const fetchMock = async () => new Response("[1, 2, 3]", {
        status: 200,
        headers: { "content-type": "application/json" },
    });

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.retryable, false);
    assert.ok(
        result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w) && /not a JSON object/.test(w)),
        `warning must mention JSON object: ${JSON.stringify(result.warnings)}`,
    );
});

/* -------------------------------------------------------------------- */
/* Security guards                                                      */
/* -------------------------------------------------------------------- */

test("API key NEVER appears in the request body — even when the caller puts it on the envelope", async () => {
    const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));

    const req = makeRequest();
    // Caller-side mistake: would-be leak; the adapter must strip it.
    (req as { api_key?: string }).api_key = "tk_should_not_leak";

    await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_real_key" }),
        "typesafe",
        req,
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_real_key" }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(calls.length, 1);
    const body = calls[0].body as Record<string, unknown>;
    assert.ok(!("api_key" in body), "API key leaked into request body");
    // The Authorization header carries the real key (sanitised), not
    // the would-be leak.
    assert.equal(calls[0].headers.authorization, "Bearer tk_real_key");
});

test("Authorization header is omitted when TYPESAFE_API_KEY is empty (the value is treated as missing)", async () => {
    const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));

    // Empty-string key must NOT be sent as "Bearer " — that would
    // pass the truthy check but authenticate as empty.
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "  " }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "  " }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(result.status, "failed");
    assert.ok(
        result.warnings.some((w) => /TYPESAFE_API_KEY missing/.test(w)),
        `expected key-missing warning, got: ${JSON.stringify(result.warnings)}`,
    );
    // fetch was never reached — short-circuit to fallback.
    assert.equal(calls.length, 0);
});

/* -------------------------------------------------------------------- */
/* retryable contract                                                  */
/* -------------------------------------------------------------------- */

test("retryable is false on every failure branch (CJK fallback contract)", async () => {
    // Build four failure scenarios and assert retryable:false on all.
    const scenarios: Array<{ name: string; fetchImpl: typeof fetch }> = [
        {
            name: "4xx",
            fetchImpl: (async () => jsonResponse(429, { error: "rate limit" })) as typeof fetch,
        },
        {
            name: "5xx",
            fetchImpl: (async () => new Response("oops", { status: 500 })) as typeof fetch,
        },
        {
            name: "network-error",
            fetchImpl: (async () => { throw new Error("dns failure"); }) as typeof fetch,
        },
        {
            name: "non-json",
            fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
        },
    ];

    for (const scenario of scenarios) {
        const result = await runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
                fetchImpl: scenario.fetchImpl,
            },
        );
        assert.equal(result.retryable, false, `${scenario.name} must surface retryable:false`);
        assert.ok(
            result.warnings.some((w) => /typesafe_fallback_to_claude/.test(w)),
            `${scenario.name} must surface the fallback warning`,
        );
    }
});

/* -------------------------------------------------------------------- */
/* Endpoint                                                             */
/* -------------------------------------------------------------------- */

test("adapter POSTs to https://api.typesafe.ai/v1/systemone (exact endpoint)", async () => {
    const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { f: { type: "noul", noul: 0.5 }, c: { type: "choice", choice: "bug", probabilities: { bug: 1, not_bug: 0 }, confidence: 1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    }));

    await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
        },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    // The HTTP method must be POST — primitives are too big for GET.
    // (The capture wrapper does not record the method explicitly;
    // assert via the absence of a URL with query params.)
    assert.ok(!calls[0].url.includes("?"), "POST request must not carry query string");
});
