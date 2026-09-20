/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.4.
 *
 * Acceptance tests for `scripts/freshness-poc.mjs`. Covers the four
 * acceptance bullets from the task:
 *
 *   1. `freshnessCheck` returns `skip: true, reason: 'state_unchanged'`
 *      when the cached `stateHash` matches the freshly computed one.
 *   2. `freshnessCheck` calls `typesafe` when hashes differ and
 *      respects the threshold (skip when `noul_yes < threshold`).
 *   3. `FACTORY_TYPESAFE_OFF=1` short-circuits (mock `fetchImpl`
 *      throws if invoked; result is `skip: false, reason:
 *      'freshness_unavailable'`).
 *   4. The `typesafe` failure fallback: mock `fetchImpl` returning
 *      HTTP 500 → `skip: false, reason: 'freshness_unavailable'`.
 *
 * The module under test is a pure-JS script (`scripts/freshness-poc.mjs`)
 * because the daemon (`scripts/factory-daemon.mjs`) is launched
 * with `process.execPath` and does not have a TypeScript runtime.
 * The test imports the JS module via tsx (the same loader `npm test`
 * already uses) and cross-checks the hash against `stateHashFor`
 * from `src/core/judgment-state.ts` to guarantee the JS and TS
 * implementations agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
    buildJudgmentState as buildJudgmentStateJs,
    stateHashFor as stateHashForJs,
    computeHealthJs,
    freshnessCheck,
    summariseFreshness,
} from "../../scripts/freshness-poc.mjs";
import { buildJudgmentState, stateHashFor } from "../core/judgment-state.js";
import { resolveAgentConfig } from "../../runtime/agent-backends.mjs";

/* -------------------------------------------------------------------------- */
/* Hash parity with `src/core/judgment-state.ts`                               */
/* -------------------------------------------------------------------------- */

function fixtureIssue() {
    return {
        number: 42,
        title: "Add a freshness check",
        body: "Skip unchanged issues.",
        labels: ["ready-to-implement"],
        updatedAt: "2026-09-20T10:00:00Z",
        createdAt: "2026-09-20T10:00:00Z",
        author: "operator",
        url: "https://example.com/42",
        comments: [
            { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
            { author: "operator", body: "Follow-up.", createdAt: "2026-09-20T10:30:00Z" },
        ],
    };
}

test("stateHashFor in JS matches stateHashFor in TypeScript for the same input", () => {
    const issue = fixtureIssue();
    const ctx = {
        factory: {
            failureCounts: {},
            lastTriageAt: "2026-09-20T11:00:00Z",
            priorDecisions: [],
        },
    };
    // `buildJudgmentState` (TS) requires `JudgmentIssueInput` whose
    // `labels` is the narrow `PipelineLabel[]`. Cast the JS-shaped
    // fixture here only; the parity check below still compares the
    // SHA-256 hex digests, which is the contract the daemon cares
    // about.
    const tsState = buildJudgmentState(issue as unknown as Parameters<typeof buildJudgmentState>[0], ctx);
    const jsState = buildJudgmentStateJs(issue, ctx);
    assert.equal(stateHashFor(tsState), stateHashForJs(jsState));
});

test("stateHashFor in JS is sensitive to every input field", () => {
    const base = fixtureIssue();
    const baseline = stateHashForJs(buildJudgmentStateJs(base));

    // updatedAt
    const withUpdatedAt = buildJudgmentStateJs({ ...base, updatedAt: "2026-09-21T00:00:00Z" });
    assert.notEqual(stateHashForJs(withUpdatedAt), baseline);

    // comments.length
    const withExtraComment = buildJudgmentStateJs({
        ...base,
        comments: [...base.comments, { author: "operator", body: "extra", createdAt: "2026-09-20T12:00:00Z" }],
    });
    assert.notEqual(stateHashForJs(withExtraComment), baseline);

    // labels
    const withExtraLabel = buildJudgmentStateJs({ ...base, labels: [...base.labels, "needs-info"] });
    assert.notEqual(stateHashForJs(withExtraLabel), baseline);

    // lastTriageAt
    const withTriageAt = buildJudgmentStateJs(base, { factory: { failureCounts: {}, lastTriageAt: "2026-09-20T11:30:00Z" } });
    assert.notEqual(stateHashForJs(withTriageAt), baseline);
});

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

function makeTmpStateDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "freshness-poc-test-"));
}

async function writeCheckpoint(stateDir: string, number: number, body: Record<string, unknown>) {
    await fs.mkdir(path.join(stateDir, "issues"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "issues", `${number}.json`), JSON.stringify(body, null, 2));
}

function makeTypesafeEnv(overrides: Record<string, string | undefined> = {}) {
    return {
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-fast",
        ...overrides,
    };
}

function captureFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
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
        calls.push({ url: typeof input === "string" ? input : input.toString(), body: parsedBody, headers });
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

function buildAgentConfig(env: NodeJS.ProcessEnv) {
    return resolveAgentConfig(env);
}

/* -------------------------------------------------------------------------- */
/* Acceptance bullet 1 — `state_unchanged` skip                                */
/* -------------------------------------------------------------------------- */

test("freshnessCheck returns skip:true, reason:'state_unchanged' when stateHash matches the cached hash", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        // Pre-compute the expected hash via the JS helper and write it
        // into the checkpoint as `lastJudgmentHash`. The function under
        // test must compute the same hash and recognise the match.
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
        });

        // Mock fetch throws — a state-unchanged skip must NOT hit typesafe.
        const fetchMock: typeof fetch = (async () => {
            throw new Error("fetch must NOT be called on state_unchanged skip");
        }) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        });

        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.stateHash, expectedHash);
        assert.equal(result.noul_yes, 0);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck persists the new stateHash to the checkpoint on every successful check", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        // Seed a real checkpoint so `persistLastJudgmentHash` has
        // something to update. Without this file the first call
        // returns `no_cached_hash` and the persist step is a no-op
        // (the test's intent is to exercise the persist path, so we
        // seed a stale hash that forces the typesafe branch instead).
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        // Mock fetch returns noul_yes=0.05 (below threshold) so the
        // skip branch fires and `persistLastJudgmentHash` runs.
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, {
            primitives: [{ id: "freshness", value: "no", confidence: 0.05 }],
        }));

        const first = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        });
        assert.equal(first.skip, true);
        assert.equal(first.reason, "state_unchanged");
        assert.ok(first.stateHash.length === 64, "stateHash is a sha-256 hex digest");

        const checkpointRaw = await fs.readFile(path.join(stateDir, "issues", `${issue.number}.json`), "utf8");
        const checkpoint = JSON.parse(checkpointRaw);
        assert.equal(checkpoint.lastJudgmentHash, first.stateHash);

        // Second call with the same issue must recognise the matching hash.
        const second = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: (async () => {
                throw new Error("fetch must NOT be called on state_unchanged skip");
            }) as typeof fetch,
        });
        assert.equal(second.skip, true);
        assert.equal(second.reason, "state_unchanged");
        assert.equal(second.stateHash, first.stateHash);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Acceptance bullet 2 — typesafe call + threshold                             */
/* -------------------------------------------------------------------------- */

test("freshnessCheck calls typesafe when the cached hash differs and skips when noul_yes < threshold", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        // Different cached hash -> function must call typesafe.
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
            primitives: [{ id: "freshness", value: "no", confidence: 0.05 }],
        }));

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        });

        // typesafe WAS called
        assert.equal(calls.length, 1, "typesafe must be called when the cached hash differs");
        assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");

        // noul_yes 0.05 < threshold 0.20 -> skip
        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.noul_yes, 0.05);
        assert.equal(result.stateHash.length, 64);

        // The hash should now be persisted on the checkpoint.
        const checkpointRaw = await fs.readFile(path.join(stateDir, "issues", `${issue.number}.json`), "utf8");
        const checkpoint = JSON.parse(checkpointRaw);
        assert.equal(checkpoint.lastJudgmentHash, result.stateHash);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck does NOT skip when typesafe returns noul_yes >= threshold", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
            primitives: [{ id: "freshness", value: "yes", confidence: 0.85 }],
        }));

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        });

        assert.equal(calls.length, 1, "typesafe must be called when the cached hash differs");
        assert.equal(result.skip, false);
        assert.equal(result.reason, "state_changed");
        assert.equal(result.noul_yes, 0.85);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck honours explicit threshold overrides (low threshold => noul_yes 0.5 still skips)", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, {
            primitives: [{ id: "freshness", value: "yes", confidence: 0.5 }],
        }));

        // threshold = 0.80 means noul_yes 0.5 < 0.80 -> skip
        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.80,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        });
        assert.equal(calls.length, 1);
        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.noul_yes, 0.5);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Acceptance bullet 3 — FACTORY_TYPESAFE_OFF=1 short-circuit                   */
/* -------------------------------------------------------------------------- */

test("freshnessCheck short-circuits to skip:false when FACTORY_TYPESAFE_OFF=1 (no outbound HTTP)", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        // fetchImpl must NEVER be called when FACTORY_TYPESAFE_OFF=1.
        const fetchMock: typeof fetch = (async () => {
            throw new Error("fetch must NOT be called when FACTORY_TYPESAFE_OFF=1");
        }) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "tk_test_secret" }),
            fetchImpl: fetchMock,
        });

        assert.equal(result.skip, false, "typesafe-off short-circuit must NOT skip");
        assert.equal(result.reason, "freshness_unavailable");
        assert.equal(result.noul_yes, 0);
        assert.equal(result.stateHash.length, 64);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Acceptance bullet 4 — failure fallback (HTTP 500)                            */
/* -------------------------------------------------------------------------- */

test("freshnessCheck falls back to skip:false on a 5xx response (HTTP 500)", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        const { fetch: fetchMock, calls } = captureFetch(async () => new Response("upstream down", { status: 500 }));

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        });

        assert.equal(calls.length, 1, "typesafe must be invoked even when we expect it to fail");
        assert.equal(result.skip, false, "5xx failure must fall back to skip:false so the existing enqueue path runs");
        assert.equal(result.reason, "freshness_unavailable");
        assert.equal(result.noul_yes, 0);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck falls back to skip:false when TYPESAFE_API_KEY is missing", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        const fetchMock: typeof fetch = (async () => {
            throw new Error("fetch must NOT be called when TYPESAFE_API_KEY is missing");
        }) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv(), // no TYPESAFE_API_KEY
            fetchImpl: fetchMock,
        });

        assert.equal(result.skip, false);
        assert.equal(result.reason, "freshness_unavailable");
        assert.equal(result.noul_yes, 0);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck returns skip:false on network error (fetch throws)", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue();
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: "0".repeat(64),
        });

        const fetchMock: typeof fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        });

        assert.equal(result.skip, false);
        assert.equal(result.reason, "freshness_unavailable");
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Composite health (T8.3 formula inlined in freshness-poc.mjs)                */
/* -------------------------------------------------------------------------- */

test("computeHealthJs matches the T8.3 weights (sum to 1.0 ± 0.01)", () => {
    // T8.3's shipped default weights
    const weights = { spec: 0.30, impl: 0.25, review: 0.20, verify: 0.25 };
    const out = computeHealthJs({ spec: 1, impl: 1, review: 1, verify: 1 }, weights);
    assert.equal(out, 1);
    const out0 = computeHealthJs({ spec: 0, impl: 0, review: 0, verify: 0 }, weights);
    assert.equal(out0, 0);
    const mid = computeHealthJs({ spec: 0.5, impl: 0.5, review: 0.5, verify: 0.5 }, weights);
    assert.equal(mid, 0.5);
});

test("computeHealthJs uses default weights when none are supplied", () => {
    const out = computeHealthJs({ spec: 0.5, impl: 0.5, review: 0.5, verify: 0.5 });
    assert.equal(out, 0.5);
});

test("computeHealthJs clamps out-of-range scores to [0, 1]", () => {
    const out = computeHealthJs({ spec: 2, impl: -1, review: 0.5, verify: 0.5 });
    // clamped: spec=1, impl=0, review=0.5, verify=0.5
    // total = 0.30*1 + 0.25*0 + 0.20*0.5 + 0.25*0.5 = 0.525
    assert.equal(Math.round(out * 1000) / 1000, 0.525);
});

test("computeHealthJs throws on missing scores", () => {
    assert.throws(
        () => computeHealthJs({ spec: 0.5 } as never),
        /score for "impl"/,
    );
});

test("computeHealthJs throws on non-finite scores", () => {
    assert.throws(
        () => computeHealthJs({ spec: Number.NaN, impl: 0.5, review: 0.5, verify: 0.5 }),
        /score for "spec"/,
    );
});

/* -------------------------------------------------------------------------- */
/* summariseFreshness                                                         */
/* -------------------------------------------------------------------------- */

test("summariseFreshness returns the documented defaults on an empty array", () => {
    const out = summariseFreshness([]);
    assert.equal(out.checked, 0);
    assert.equal(out.skipped, 0);
    assert.equal(out.fresh, 0);
    assert.equal(out.unavailable, 0);
    assert.equal(out.skippedRate, 0);
});

test("summariseFreshness counts skipped / fresh / unavailable outcomes", () => {
    const out = summariseFreshness([
        { skipped: true, unavailable: false },
        { skipped: false, unavailable: true },
        { skipped: false, unavailable: false },
        { skipped: true, unavailable: false },
    ]);
    assert.equal(out.checked, 4);
    assert.equal(out.skipped, 2);
    assert.equal(out.fresh, 2);
    assert.equal(out.unavailable, 1);
    assert.equal(out.skippedRate, 0.5);
});
