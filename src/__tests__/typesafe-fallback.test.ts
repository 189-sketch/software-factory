/**
 * T8.5 acceptance — `src/__tests__/typesafe-fallback.test.ts`.
 *
 * Covers the three CJK fallback trigger conditions from
 * `specs/2026-09-20-decision-architecture/requirements.md`
 * §"CJK Fallback Contract" §1:
 *
 *   - Trigger 1: `POST https://api.typesafe.ai/v1/systemone` returns
 *     4xx / 5xx / times out / throws a network error.
 *   - Trigger 2: `TYPESAFE_API_KEY` is missing or invalid.
 *   - Trigger 3: per-action confidence of the mapped gate head (the
 *     first requested question) falls below
 *     `decisions.yaml[<action>].escalate.confidence_max`.
 *
 * Plus the cross-cutting contract bullets:
 *
 *   - The synthetic envelope is
 *     `{ status: "failed", warnings: ["typesafe_fallback_to_claude: <reason>"], retryable: false, providerSessionId: null, backend: "typesafe" }`.
 *   - No auto-retry: `retryable: false` on every failure branch
 *     (`decision-architecture` §"Behaviour" — until Phase 11 Slice F
 *     `FACTORY_AGENT_BACKEND_FALLBACK` lands, the orchestrator does
 *     NOT auto-re-run on Claude).
 *
 * Trigger 1 + Trigger 2 are already covered by the broader
 * `typesafe-backend.test.ts` suite; this file pins the fallback
 * envelope shape end-to-end so a refactor of
 * `runTypesafeStageFromConfig` cannot silently drop either trigger or
 * regress the warning prefix.
 *
 * The 3rd trigger (per-action confidence) is the opt-in capability
 * landed in T8.5: when the caller supplies `opts.action` and
 * `opts.decisions`, the adapter compares
 * `structuredOutput[0].confidence < decisions.yaml[<action>].escalate.confidence_max`
 * and returns the same fallback envelope. The orchestrator's
 * `decisionRouter` (Phase C) wires those opts in; here we exercise
 * the contract directly so future migration tasks have a clean seam.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runTypesafeStageFromConfig } from "../../runtime/typesafe-backend.mjs";
import { resolveAgentConfig } from "../../runtime/agent-backends.mjs";
import type { TypesafeRequest, TypesafeResponse } from "../../runtime/typesafe-backend.d.mts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeConfig(overrides: Record<string, string | undefined> = {}) {
    return resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "claude-code",
        ...overrides,
    });
}

/** Minimal official envelope: one choice question, so the gate head
 * has a confidence channel. */
function makeRequest(): TypesafeRequest {
    return {
        model: "jev-latest",
        state: { issueNumber: 42, title: "Test issue" },
        questions: {
            p1: {
                type: "choice",
                instructions: "Should we apply the bug label?",
                criteria: { bug: "yes", not_bug: "no" },
            },
        },
    };
}

/**
 * The minimal env bag the adapter receives via `opts.env`. Mirrors
 * what `agentWorkerEnvironment` would produce for a `typesafe`
 * selection so the adapter's logic is exercised against a real env
 * shape, not a hand-rolled stub.
 */
function typesafeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-latest",
        ...overrides,
    };
}

/** JSON response helper. */
function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** Minimal `decisions.yaml`-shaped fixture covering the example actions. */
const TRIAGE_RULE = {
    action: "triage.apply_label",
    auto: { confidence_min: 0.85 },
    confirm: { confidence_min: 0.5 },
    escalate: { confidence_max: 0.5, target: "needs-info" },
};

const DECISIONS_SHAPE = {
    version: 1,
    decisions: [TRIAGE_RULE],
    composite: { spec: 0.3, impl: 0.25, review: 0.2, verify: 0.25 },
    fallback: { cjk: { trigger: "any_of" as const, conditions: [], fallback_backend: "claude-code", log_warning: "typesafe_fallback_to_claude" } },
};

/* -------------------------------------------------------------------------- */
/* Shared assertions — every fallback path must satisfy this envelope.        */
/* -------------------------------------------------------------------------- */

function assertFallbackShape(
    result: unknown,
    opts: { reasonPattern?: RegExp; from?: "typesafe" | "claude-code" } = {},
) {
    const r = result as Record<string, unknown>;
    assert.equal(r.status, "failed", `status must be "failed"; got ${String(r.status)}`);
    assert.equal(r.retryable, false, "retryable must be false on every fallback path");
    assert.equal(r.providerSessionId, null, "providerSessionId must be null on every fallback path");
    assert.equal(r.backend, "typesafe", "backend must be 'typesafe' on every fallback path");
    assert.ok(Array.isArray(r.warnings), "warnings must be an array");
    const warnings = r.warnings as string[];
    assert.ok(
        warnings.some((w) => /typesafe_fallback_to_claude/.test(w)),
        `warnings must include the contractual fallback prefix: ${JSON.stringify(warnings)}`,
    );
    if (opts.reasonPattern) {
        assert.ok(
            warnings.some((w) => opts.reasonPattern!.test(w)),
            `warnings must surface the failure reason (${opts.reasonPattern}): ${JSON.stringify(warnings)}`,
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Trigger 1 — network / 4xx / 5xx                                            */
/* -------------------------------------------------------------------------- */

test("trigger 1: HTTP 401 produces the CJK fallback envelope", async () => {
    const fetchMock = async () => jsonResponse(401, { error: "unauthorized" });

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assertFallbackShape(result, { reasonPattern: /401/ });
});

test("trigger 1: HTTP 500 produces the CJK fallback envelope", async () => {
    const fetchMock = async () => new Response("upstream down", { status: 500 });

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assertFallbackShape(result, { reasonPattern: /500/ });
});

test("trigger 1: network error (ECONNREFUSED) produces the CJK fallback envelope", async () => {
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

    assertFallbackShape(result, { reasonPattern: /ECONNREFUSED/ });
});

test("trigger 1: timeout (AbortSignal.timeout fires) produces the CJK fallback envelope", async () => {
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
            // Model an active network request: AbortSignal.timeout alone is unref'ed.
            const pendingRequest = setTimeout(() => reject(new Error('Expected request abort')), 1000);
            const signal = init?.signal as AbortSignal | undefined;
            if (signal) {
                signal.addEventListener("abort", () => {
                    clearTimeout(pendingRequest);
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

    assertFallbackShape(result);
});

test("trigger 1: non-JSON response body produces the CJK fallback envelope", async () => {
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

    assertFallbackShape(result, { reasonPattern: /JSON/i });
});

/* -------------------------------------------------------------------------- */
/* Trigger 2 — missing / invalid `TYPESAFE_API_KEY`                           */
/* -------------------------------------------------------------------------- */

test("trigger 2: missing TYPESAFE_API_KEY short-circuits to CJK fallback (fetch never reached)", async () => {
    let fetchCalls = 0;
    const fetchMock = async () => {
        fetchCalls += 1;
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

    assertFallbackShape(result, { reasonPattern: /TYPESAFE_API_KEY missing/ });
    assert.equal(fetchCalls, 0, "fetchImpl must never be reached when the API key is missing");
});

test("trigger 2: whitespace-only TYPESAFE_API_KEY is treated as missing (fetch never reached)", async () => {
    let fetchCalls = 0;
    const fetchMock = async () => {
        fetchCalls += 1;
        throw new Error("fetch should not have been called for whitespace-only key");
    };

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "  " }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "  " }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assertFallbackShape(result, { reasonPattern: /TYPESAFE_API_KEY missing/ });
    assert.equal(fetchCalls, 0, "fetchImpl must never be reached for whitespace-only key");
});

/* -------------------------------------------------------------------------- */
/* Trigger 3 (REMOVED 2026-09-22) — low confidence is a routing signal,        */
/* not a model-unavailable signal. The adapter no longer collapses low-         */
/* confidence answers into a CJK fallback envelope; the caller's              */
/* `applyDecision` escalate / confirm tiers do it instead.                    */
/* -------------------------------------------------------------------------- */

test("trigger 3: structuredOutput[0].confidence at-or-above threshold → succeeds (no fallback)", async () => {
    // 0.51 is just above 0.50 — the check is strict `<`, not `<=`.
    const responseBody: TypesafeResponse = {
        model: "jev-1.13.0",
        answers: {
            p1: { type: "choice", choice: "bug", probabilities: { bug: 0.51, "not_bug": 0.49 }, confidence: 0.51 },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
    };
    const fetchMock = async () => jsonResponse(200, responseBody);

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
            action: "triage.apply_label",
            decisions: DECISIONS_SHAPE,
        },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.retryable, false);
});

test("trigger 3: when opts.action is missing, the confidence check is skipped (back-compat with T8.1)", async () => {
    // The same low-confidence response, but with no `action` opts.
    // The adapter must NOT trigger fallback — T8.1 callers rely on
    // this behaviour until Phase C wires decisionRouter.
    const responseBody: TypesafeResponse = {
        model: "jev-1.13.0",
        answers: { p1: { type: "choice", choice: "x", probabilities: { x: 0.1, y: 0.9 }, confidence: 0.1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    };
    const fetchMock = async () => jsonResponse(200, responseBody);

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
            // action omitted on purpose
        },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.warnings, []);
});

test("trigger 3: when opts.action is set but the action is unknown to decisions.yaml, no fallback fires", async () => {
    // Defensive: unknown actions must not crash the adapter or
    // spuriously trigger fallback.
    const responseBody: TypesafeResponse = {
        model: "jev-1.13.0",
        answers: { p1: { type: "choice", choice: "x", probabilities: { x: 0.1, y: 0.9 }, confidence: 0.1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    };
    const fetchMock = async () => jsonResponse(200, responseBody);

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
            action: "future.action",
            decisions: DECISIONS_SHAPE, // does NOT contain "future.action"
        },
    );

    assert.equal(result.status, "succeeded");
});

/* -------------------------------------------------------------------------- */
/* CJK fallback log fields — every path emits the structured {reason, from, to}. */
/* -------------------------------------------------------------------------- */

test("CJK fallback log fields are emitted on the FACTORY_TYPESAFE_OFF path", async () => {
    const fallback = {
        reason: "FACTORY_TYPESAFE_OFF=1",
        from_backend: "typesafe",
        to_backend: "claude-code",
    };

    const result = await runTypesafeStageFromConfig(
        makeConfig({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: (async () => { throw new Error("unreachable"); }) as typeof fetch,
        },
    );

    assert.equal(result.backend, fallback.from_backend);
    assert.equal(result.warnings.length >= 1, true);
    assert.ok(/typesafe_fallback_to_claude/.test(result.warnings[0]));
    assert.ok(result.warnings[0].includes(fallback.reason));
    assert.ok(
        /typesafe_fallback_to_claude:/.test(result.warnings[0]),
        `warning must carry the canonical 'fallback_to_claude' prefix: ${result.warnings[0]}`,
    );
});

test("CJK fallback log fields are emitted on the missing-key path", async () => {
    const result = await runTypesafeStageFromConfig(
        makeConfig({}), // no key
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({}),
            fetchImpl: (async () => { throw new Error("unreachable"); }) as typeof fetch,
        },
    );

    assert.equal(result.backend, "typesafe");
    assert.match(result.warnings[0], /typesafe_fallback_to_claude: TYPESAFE_API_KEY missing/);
});

test("CJK fallback log fields are emitted on the 5xx path", async () => {
    const fetchMock = async () => new Response("oops", { status: 503 });
    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
        },
    );

    assert.equal(result.backend, "typesafe");
    assert.match(result.warnings[0], /typesafe_fallback_to_claude: http 503/);
});

test("low-confidence answers flow through as succeeded (no CJK fallback)", async () => {
    const fetchMock = async () => jsonResponse(200, {
        model: "jev-1.13.0",
        answers: { p1: { type: "choice", choice: "x", probabilities: { x: 0.1, y: 0.9 }, confidence: 0.1 } },
        usage: { input_tokens: 0, output_tokens: 0 },
    });

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock as typeof fetch,
            action: "triage.apply_label",
            decisions: DECISIONS_SHAPE,
        },
    );

    assert.equal(result.backend, "typesafe");
    assert.equal(result.status, "succeeded");
    assert.equal(Array.isArray(result.structuredOutput) ? result.structuredOutput.length : 0, 1);
});

/* -------------------------------------------------------------------------- */
/* No auto-retry — retryable: false is contractual on every fallback branch.  */
/* -------------------------------------------------------------------------- */

test("retryable is false on every fallback branch (Trigger 1 + 2 + 3)", async () => {
    // Five failure scenarios covering all three trigger conditions.
    // `retryable: false` is the contract — a transient retry would
    // just repeat the same failure until Phase 11 Slice F
    // (`FACTORY_AGENT_BACKEND_FALLBACK` opt-in) lands.
    const scenarios: Array<{ name: string; build: () => Promise<unknown> }> = [];

    // Trigger 1 — 4xx
    scenarios.push({
        name: "trigger-1-4xx",
        build: () => runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
                fetchImpl: (async () => jsonResponse(429, { error: "rate limit" })) as typeof fetch,
            },
        ),
    });

    // Trigger 1 — 5xx
    scenarios.push({
        name: "trigger-1-5xx",
        build: () => runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
                fetchImpl: (async () => new Response("oops", { status: 500 })) as typeof fetch,
            },
        ),
    });

    // Trigger 1 — network
    scenarios.push({
        name: "trigger-1-network",
        build: () => runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "tk_test_secret" }),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
                fetchImpl: (async () => { throw new Error("dns failure"); }) as typeof fetch,
            },
        ),
    });

    // Trigger 2 — missing key
    scenarios.push({
        name: "trigger-2-missing-key",
        build: () => runTypesafeStageFromConfig(
            makeConfig({}),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({}),
                fetchImpl: (async () => { throw new Error("unreachable"); }) as typeof fetch,
            },
        ),
    });

    // (Trigger 3 — confidence-below-threshold was removed 2026-09-22:
    // low confidence is a routing signal handled by the caller's
    // `applyDecision`, not an adapter-level fallback. Verified
    // directly in `typesafe-backend.test.ts` instead.)

    for (const scenario of scenarios) {
        const result = (await scenario.build()) as Record<string, unknown>;
        assert.equal(result.retryable, false, `${scenario.name} must surface retryable:false`);
        assert.equal(result.status, "failed", `${scenario.name} must surface status:failed`);
        assert.ok(
            Array.isArray(result.warnings)
                && (result.warnings as string[]).some((w) => /typesafe_fallback_to_claude/.test(w)),
            `${scenario.name} must surface the contractual fallback warning`,
        );
    }
});
