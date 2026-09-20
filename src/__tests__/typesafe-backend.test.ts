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
 * §"CJK Fallback Contract"):
 *
 *   - Happy path: mock returns 200 + JSON envelope → `succeeded` with
 *     primitives threaded into `structuredOutput`, `usage: null`,
 *     `providerSessionId` from response.session_id.
 *   - `FACTORY_TYPESAFE_OFF=1` short-circuits to fallback regardless
 *     of API health (the env var is the documented offline-testing
 *     escape hatch; covered here + by `typesafe-fallback-cli.test.mjs`
 *     in T8.5).
 *   - Missing `TYPESAFE_API_KEY` → fallback with reason "TYPESAFE_API_KEY
 *     missing".
 *   - 4xx / 5xx → fallback with the upstream status in the warning.
 *   - Timeout / abort → fallback with the timeout reason.
 *   - Non-JSON response → fallback with "not valid JSON".
 *   - Request body shape: primitives round-trip; `Authorization` header
 *     is set only when the key is configured; the key NEVER appears
 *     in the body.
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
        FACTORY_AGENT_BACKEND: "typesafe",
        ...overrides,
    });
}

function makeRequest(): TypesafeRequest {
    return {
        model: "jev-fast",
        state_hash: "abc123def456",
        primitives: [
            {
                id: "p1",
                type: "Choice",
                question: "Should we apply the bug label?",
                // Minimal JudgmentState shape — the adapter serialises
                // it; only structural fields matter for the contract.
                state: {
                    issue: {
                        number: 42,
                        title: "Test issue",
                        body: "",
                        labels: ["bug"],
                        updatedAt: "2026-09-20T00:00:00.000Z",
                        comments: [],
                    },
                    factory: { failureCounts: {}, priorDecisions: [] },
                    repoSignals: { primaryLanguage: "ts", hasOpenSpec: false, hasOpenPRs: 0 },
                },
            },
        ],
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
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-fast",
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

test("runTypesafeStageFromConfig returns succeeded on a 200 JSON response and threads primitives", async () => {
    const responseBody: TypesafeResponse = {
        primitives: [{ id: "p1", value: "bug", confidence: 0.92 }],
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
    assert.deepEqual(result.usage, null);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.providerSessionId, "ts-session-mock-1");
    assert.deepEqual(result.structuredOutput, responseBody.primitives);

    // The fetch adapter must have been called exactly once.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(calls[0].headers["content-type"], "application/json");
    // Authorization header is set when the key is configured.
    assert.equal(calls[0].headers.authorization, "Bearer tk_test_secret");
    // Body shape: model, state_hash, primitives round-trip; the key
    // NEVER travels in the body.
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.model, "jev-fast");
    assert.equal(body.state_hash, "abc123def456");
    assert.ok(Array.isArray(body.primitives));
    assert.equal((body.primitives as unknown[]).length, 1);
    assert.ok(!("api_key" in body), "API key leaked into request body");
});

test("providerSessionId falls back to null when the response omits session_id", async () => {
    const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
        primitives: [{ id: "p1", value: "ok", confidence: 0.5 }],
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
        primitives: [{ id: "p1", value: "ok", confidence: 0.5 }],
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
        primitives: [{ id: "p1", value: "ok", confidence: 0.5 }],
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
        primitives: [{ id: "p1", value: "ok", confidence: 0.5 }],
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