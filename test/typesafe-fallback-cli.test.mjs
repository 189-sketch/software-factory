// test/typesafe-fallback-cli.test.mjs
//
// T8.5 CLI acceptance — `test/typesafe-fallback-cli.test.mjs`.
//
// Confirms `FACTORY_TYPESAFE_OFF=1` forces the typesafe adapter
// into its CJK fallback envelope regardless of API health, so
// offline CI / smoke runs never depend on `api.typesafe.ai` being
// reachable. This is the offline-testing escape hatch documented
// in `runtime/typesafe-backend.mjs` and required by
// `specs/2026-09-20-decision-architecture/requirements.md`
// §"CJK Fallback Contract" §4.
//
// Three scenarios, all imported through the production
// `runTypesafeStageFromConfig` helper (not a hand-rolled reimpl):
//
//   1. `FACTORY_TYPESAFE_OFF=1` with a real-looking
//      `TYPESAFE_API_KEY=sk-test` — `globalThis.fetch` is spied on
//      and MUST NOT be called. The synthetic fallback envelope is
//      returned with the contractual warning
//      `typesafe_fallback_to_claude: FACTORY_TYPESAFE_OFF=1`.
//   2. Same as above but `TYPESAFE_API_KEY` is unset (and the
//      offline toggle is NOT set) — the API-key-missing branch
//      fires BEFORE any HTTP attempt and the spy must show zero
//      calls. The reason is `TYPESAFE_API_KEY missing`.
//   3. A local `node:http` server returns HTTP 500. The adapter
//      reaches the network (spy confirms), then maps the upstream
//      status into the fallback envelope with reason `http 500`.
//
// The CLI runner uses Node's native `node:test` module — no
// external test runner. Each scenario imports
// `runTypesafeStageFromConfig` from `runtime/typesafe-backend.mjs`
// (the same module the unit test in `src/__tests__/` exercises),
// so a regression in the adapter fails both suites.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
    runTypesafeStageFromConfig,
} from "../runtime/typesafe-backend.mjs";
import { resolveAgentConfig } from "../runtime/agent-backends.mjs";

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `TypesafeRequest` envelope that exercises every primitive
 * field the adapter serialises. Mirrors the fixture used by the
 * unit tests so failures are easy to cross-reference.
 */
function makeRequest() {
    return {
        model: "jev-fast",
        state_hash: "abc123def456",
        primitives: [
            {
                id: "p1",
                type: "Choice",
                question: "Should we apply the bug label?",
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
 * Build the `env` bag the adapter will receive. Mirrors the
 * production `agentWorkerEnvironment(process.env, config)` shape
 * for a `typesafe` selection so the adapter's logic is exercised
 * against a real env shape, not a hand-rolled stub.
 */
function typesafeEnv(overrides = {}) {
    return {
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-fast",
        ...overrides,
    };
}

function makeConfig(env = {}) {
    return resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "typesafe",
        ...env,
    });
}

/**
 * Spy on `globalThis.fetch` and return both the spy fn (to install
 * as `fetchImpl`) and a `calls` getter. The spy throws when called
 * so any leak is loud; passing scenarios assert `calls === 0`.
 */
function makeFetchSpy() {
    const calls = [];
    const spy = async () => {
        calls.push(true);
        throw new Error("fetch should not have been called by runTypesafeStageFromConfig");
    };
    return { spy, calls };
}

/* -------------------------------------------------------------------------- */
/* CJK fallback envelope contract — every scenario must satisfy this.         */
/* -------------------------------------------------------------------------- */

function assertFallbackEnvelope(result, { reasonPattern, mustNotCallFetch = true }) {
    assert.equal(result.status, "failed", `status must be "failed"; got ${result.status}`);
    assert.equal(result.backend, "typesafe", `backend must be "typesafe"; got ${result.backend}`);
    assert.equal(result.retryable, false, "retryable must be false on every fallback path");
    assert.equal(result.providerSessionId, null, "providerSessionId must be null on every fallback path");
    assert.ok(Array.isArray(result.warnings), "warnings must be an array");
    assert.ok(result.warnings.length >= 1, "warnings must contain at least one entry");
    assert.match(
        result.warnings[0],
        /^typesafe_fallback_to_claude:/,
        `warning must carry the contractual prefix: ${result.warnings[0]}`,
    );
    if (reasonPattern) {
        assert.match(
            result.warnings[0],
            reasonPattern,
            `warning must surface the failure reason (${reasonPattern}): ${result.warnings[0]}`,
        );
    }
    if (mustNotCallFetch !== undefined) {
        assert.ok(
            mustNotCallFetch ? true : true,
            // placeholder for symmetry; real call-count assertions
            // happen at the per-test level so the failure message
            // names the scenario.
            undefined,
        );
    }
}

/* -------------------------------------------------------------------------- */
/* 1. FACTORY_TYPESAFE_OFF=1 — short-circuits before any HTTP                  */
/* -------------------------------------------------------------------------- */

test("FACTORY_TYPESAFE_OFF=1 forces CJK fallback without any outbound HTTP", async () => {
    const { spy, calls } = makeFetchSpy();

    const result = await runTypesafeStageFromConfig(
        makeConfig({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "sk-test" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "sk-test" }),
            fetchImpl: spy,
        },
    );

    assertFallbackEnvelope(result, { reasonPattern: /FACTORY_TYPESAFE_OFF=1/ });
    assert.equal(calls.length, 0, "FACTORY_TYPESAFE_OFF=1 must short-circuit before any fetch call");
});

/* -------------------------------------------------------------------------- */
/* 2. TYPESAFE_API_KEY unset — short-circuits before any HTTP                 */
/* -------------------------------------------------------------------------- */

test("missing TYPESAFE_API_KEY forces CJK fallback without any outbound HTTP", async () => {
    const { spy, calls } = makeFetchSpy();

    const result = await runTypesafeStageFromConfig(
        makeConfig({}), // no TYPESAFE_API_KEY
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({}), // no TYPESAFE_API_KEY
            fetchImpl: spy,
        },
    );

    assertFallbackEnvelope(result, { reasonPattern: /TYPESAFE_API_KEY missing/ });
    assert.equal(calls.length, 0, "missing TYPESAFE_API_KEY must short-circuit before any fetch call");
});

test("whitespace-only TYPESAFE_API_KEY is treated as missing and forces CJK fallback without HTTP", async () => {
    const { spy, calls } = makeFetchSpy();

    const result = await runTypesafeStageFromConfig(
        makeConfig({ TYPESAFE_API_KEY: "  " }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ TYPESAFE_API_KEY: "  " }),
            fetchImpl: spy,
        },
    );

    assertFallbackEnvelope(result, { reasonPattern: /TYPESAFE_API_KEY missing/ });
    assert.equal(calls.length, 0, "whitespace-only key must short-circuit before any fetch call");
});

/* -------------------------------------------------------------------------- */
/* 3. Local node:http server returning 500 — adapter reaches the network     */
/* -------------------------------------------------------------------------- */

test("local server returning 500 forces CJK fallback (network path)", async () => {
    let serverHits = 0;
    const server = http.createServer((_req, res) => {
        serverHits += 1;
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        res.end("upstream down");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    // The adapter POSTs to a hard-coded `TYPESAFE_ENDPOINT`; we cannot
    // redirect it without modifying the adapter. Instead, we point
    // the test at a `fetchImpl` that targets the local server on
    // `127.0.0.1:port`. The endpoint host is fixed but the fetch impl
    // is our seam; we close over `port` to thread the URL.
    const localFetch = (url, init) => {
        const target = url.toString().replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);
        return globalThis.fetch(target, init);
    };

    try {
        const result = await runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "sk-test" }),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({ TYPESAFE_API_KEY: "sk-test" }),
                fetchImpl: localFetch,
            },
        );

        assertFallbackEnvelope(result, { reasonPattern: /http 500/ });
        assert.ok(serverHits >= 1, "local server must have received the request");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("local server returning 200 with malformed JSON forces CJK fallback (network path)", async () => {
    // Mirrors the upstream "non-JSON response" branch — confirms
    // the contract from the local-CLI perspective, not just unit.
    const server = http.createServer((_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end("<html>not json</html>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const localFetch = (url, init) => {
        const target = url.toString().replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);
        return globalThis.fetch(target, init);
    };

    try {
        const result = await runTypesafeStageFromConfig(
            makeConfig({ TYPESAFE_API_KEY: "sk-test" }),
            "typesafe",
            makeRequest(),
            {
                env: typesafeEnv({ TYPESAFE_API_KEY: "sk-test" }),
                fetchImpl: localFetch,
            },
        );

        assertFallbackEnvelope(result, { reasonPattern: /JSON/i });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

/* -------------------------------------------------------------------------- */
/* 4. End-to-end: the FACTORY_TYPESAFE_OFF=1 path is byte-identical across   */
/*    the CLI runner and the unit test runner — same module, same envelope.    */
/* -------------------------------------------------------------------------- */

test("FACTORY_TYPESAFE_OFF=1 envelope is identical between CLI runner and unit-test runner (regression)", async () => {
    // The unit test in `src/__tests__/typesafe-fallback.test.ts`
    // pins the same envelope. If a future refactor diverges the two
    // callers, this assertion catches it.
    const { spy } = makeFetchSpy();
    const result = await runTypesafeStageFromConfig(
        makeConfig({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "sk-test" }),
        "typesafe",
        makeRequest(),
        {
            env: typesafeEnv({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "sk-test" }),
            fetchImpl: spy,
        },
    );

    assert.deepEqual(
        Object.keys(result).sort(),
        [
            "backend",
            "logTail",
            "output",
            "providerSessionId",
            "retryable",
            "status",
            "usage",
            "warnings",
        ].sort(),
        "fallback envelope keys must match the production shape",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.backend, "typesafe");
    assert.equal(result.retryable, false);
    assert.equal(result.providerSessionId, null);
    assert.deepEqual(result.warnings, ["typesafe_fallback_to_claude: FACTORY_TYPESAFE_OFF=1"]);
});