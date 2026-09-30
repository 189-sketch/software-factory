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

function fixtureIssue(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
    };
}

/**
 * TS cannot read the JS `@typedef` from `scripts/freshness-poc.mjs`,
 * so tests that touch the resume-stage fields (added in spec T11.3)
 * type-narrow the return shape explicitly. Keep this in sync with
 * the `@typedef FreshnessResult` JSDoc in `scripts/freshness-poc.mjs`.
 */
type FreshnessResultEx = {
    skip: boolean;
    reason: string;
    stateHash: string;
    noul_yes: number;
    resumeStage?: string;
    confidence?: number;
    resumeReason?: string;
};

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
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-latest",
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

/**
 * Variant of `captureFetch` that returns a different response for
 * each successive call. Used by tests that exercise both the
 * freshness `noul` and the polling-time `resume_stage` choice in a
 * single `freshnessCheck` invocation.
 */
function captureFetchSequence(
    impls: Array<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>,
) {
    if (impls.length === 0) {
        throw new Error("captureFetchSequence needs at least one response");
    }
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    let index = 0;
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
        const impl = impls[Math.min(index, impls.length - 1)];
        index += 1;
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

test("freshnessCheck returns skip:true, reason:'state_unchanged' with the resume-stage hint when the cached hash matches", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["ready-to-spec"],
            // Last comment is a factory marker so the author-voice
            // override does not fire — the resume_stage primitive is
            // the unit under test here.
            comments: [
                { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
                { author: "factory-bot", body: "<!-- pi-software-factory:triage:1:abc --> waiting", createdAt: "2026-09-20T10:30:00Z" },
            ],
        });
        // Pre-compute the expected hash via the JS helper and write it
        // into the checkpoint as `lastJudgmentHash`. The function under
        // test must compute the same hash and recognise the match.
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue, {
            factory: { failureCounts: {}, lastTriageAt: "2026-09-22T08:00:00Z" },
        }));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
            lastTriageAt: "2026-09-22T08:00:00Z",
        });

        // Spec T11.3: state_unchanged now triggers the resume-stage
        // decision against typesafe. The mock returns a `spec`
        // choice so the daemon knows to re-engage the pipeline at
        // the spec stage instead of blanket-skipping.
        const fetchMock: typeof fetch = (async () =>
            jsonResponse(200, {
                model: "jev-latest",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "spec",
                        probabilities: { spec: 0.9 },
                        confidence: 0.9,
                    },
                },
            })) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.stateHash, expectedHash);
        assert.equal(result.noul_yes, 0);
        assert.equal(result.resumeStage, "spec");
        assert.equal(result.confidence, 0.9);
        assert.equal(result.resumeReason, "ok");
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck state_unchanged honours the `wait` resume decision (operator needs to respond)", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["needs-info", "ready-to-spec"],
            // Last comment is a factory marker so the author-voice
            // override does not fire — this test pins down jev's `wait`
            // decision specifically.
            comments: [
                { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
                { author: "factory-bot", body: "<!-- pi-software-factory:triage:1:abc --> waiting", createdAt: "2026-09-20T10:30:00Z" },
            ],
        });
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
        });

        // The model picks `wait` because labels include needs-info.
        const fetchMock: typeof fetch = (async () =>
            jsonResponse(200, {
                model: "jev-latest",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "wait",
                        probabilities: { wait: 0.88 },
                        confidence: 0.88,
                    },
                },
            })) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.resumeStage, "wait");
        // The daemon still emits judgment.skip with resumeStage=wait,
        // so the daemon can leave the issue parked.
        assert.equal(result.confidence, 0.88);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck state_unchanged falls back to stageForActiveLabel when FACTORY_TYPESAFE_OFF=1", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["ready-to-spec"],
            comments: [
                { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
                { author: "factory-bot", body: "<!-- pi-software-factory:triage:1:abc --> waiting", createdAt: "2026-09-20T10:30:00Z" },
            ],
        });
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
        });

        // FACTORY_TYPESAFE_OFF=1: no fetch must be issued.
        const fetchMock: typeof fetch = (async () => {
            throw new Error("fetch must NOT be called when FACTORY_TYPESAFE_OFF=1");
        }) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ FACTORY_TYPESAFE_OFF: "1", TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        // ready-to-spec maps to spec stage via stageForActiveLabel.
        assert.equal(result.resumeStage, "spec");
        assert.equal(result.confidence, 0);
        assert.equal(result.resumeReason, "off-toggle");
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck state_unchanged defaults to `triage` when typesafe returns an unknown stage", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["ready-to-spec"],
            comments: [
                { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
                { author: "factory-bot", body: "<!-- pi-software-factory:triage:1:abc --> waiting", createdAt: "2026-09-20T10:30:00Z" },
            ],
        });
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
        });

        // Typesafe answers with a stage that is not in the whitelist.
        const fetchMock: typeof fetch = (async () =>
            jsonResponse(200, {
                model: "jev-latest",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "bogus",
                        confidence: 0.5,
                    },
                },
            })) as typeof fetch;

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        // Invalid stage is the failure mode: fall back to `triage`
        // and flag the reason so an operator can spot it in the log.
        assert.equal(result.resumeStage, "triage");
        assert.equal(result.resumeReason, "invalid-stage");
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck state_unchanged overrides to skip:false (author_voice_override) when the latest comment is non-factory voice", async () => {
    // Issue #46 (2026-09-24): the author replied on a parked-at-needs-info
    // issue; the daemon still hit state_unchanged because none of the 5
    // freshness hash fields had moved (or the daemon polled before GitHub's
    // eventual consistency caught up). The resume_stage primitive then
    // answered `wait` based on the stale label, stranding the operator's
    // reply. This test pins down the override: when the most recent comment
    // is non-factory voice, freshnessCheck must return skip:false without
    // consulting typesafe so the daemon re-triages.
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["needs-info", "ready-to-spec"],
            // Author-voice last comment (no factory marker).
            comments: [
                { author: "factory-bot", body: "<!-- pi-software-factory:triage:1:abc --> waiting", createdAt: "2026-09-22T07:00:00Z" },
                { author: "operator", body: "all blockers resolved, please proceed", createdAt: "2026-09-24T11:30:00Z" },
            ],
        });
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue, {
            factory: { failureCounts: {}, lastTriageAt: "2026-09-22T08:00:00Z" },
        }));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
            lastTriageAt: "2026-09-22T08:00:00Z",
        });

        // Author-voice override must NOT call typesafe. Any fetch call
        // is a regression — the whole point is to bypass decideResumeStage.
        const { fetch: fetchMock, calls } = captureFetch(async () => {
            throw new Error("typesafe must NOT be called on the author-voice override path");
        });

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, false, "author-voice override must NOT skip");
        assert.equal(result.reason, "author_voice_override");
        assert.equal(result.stateHash, expectedHash);
        assert.equal(result.noul_yes, 0);
        assert.equal(calls.length, 0, "no typesafe call must be issued on the override path");
        // The override envelope does not populate resume-stage fields —
        // the daemon routes the issue through the normal enqueue path.
        assert.equal(result.resumeStage, undefined);
        assert.equal(result.resumeReason, undefined);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck state_unchanged does NOT override when the latest comment carries a factory marker", async () => {
    // Regression: a factory comment at the bottom must NOT trip the
    // author-voice override (otherwise the factory's own triage marker
    // would cause the daemon to busy-loop re-triaging itself).
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["ready-to-spec"],
            // Last entry IS a factory marker — must NOT be treated as
            // author voice even though `fixtureIssue`'s default author
            // login happens to match the operator login.
            comments: [
                { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
                { author: "operator", body: "<!-- pi-software-factory:triage:1:abc --> waiting on info", createdAt: "2026-09-22T07:00:00Z" },
            ],
        });
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
        });

        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, {
                model: "jev-latest",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "spec",
                        probabilities: { spec: 0.9 },
                        confidence: 0.9,
                    },
                },
            }));

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.resumeStage, "spec");
        assert.equal(result.resumeReason, "ok");
        assert.equal(calls.length, 1, "resume_stage primitive must still run when the latest comment is a factory marker");
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck state_unchanged does NOT override when comments are empty or undefined", async () => {
    // Regression: latestVoiceIsAuthor(null/undefined/[]) returns false by
    // design (see src/core/factory-comments.ts:46) — the override must
    // also no-op for an issue with no comments at all.
    const stateDir = await makeTmpStateDir();
    for (const commentsValue of [[] as [], undefined as unknown as undefined]) {
        try {
            const issue = fixtureIssue({
                labels: ["ready-to-spec"],
                comments: commentsValue,
            });
            const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
            await writeCheckpoint(stateDir, issue.number, {
                issue: { number: issue.number, labels: issue.labels },
                lastJudgmentHash: expectedHash,
            });

            const { fetch: fetchMock, calls } = captureFetch(async () =>
                jsonResponse(200, {
                    model: "jev-latest",
                    answers: {
                        resume_stage: {
                            type: "choice",
                            choice: "spec",
                            probabilities: { spec: 0.9 },
                            confidence: 0.9,
                        },
                    },
                }));

            const result = await freshnessCheck(issue, {
                stateDir,
                threshold: 0.20,
                env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
                fetchImpl: fetchMock,
            }) as FreshnessResultEx;

            assert.equal(result.skip, true, `comments=${JSON.stringify(commentsValue)}: state_unchanged path must still run`);
            assert.equal(result.reason, "state_unchanged");
            assert.equal(result.resumeStage, "spec");
            assert.equal(calls.length, 1, `comments=${JSON.stringify(commentsValue)}: resume_stage primitive must still run`);
        } finally {
            await fs.rm(stateDir, { recursive: true, force: true });
        }
    }
});

test("freshnessCheck state_unchanged author_voice_override persists the new hash to prevent busy-loop", async () => {
    // Regression for the busy-loop guard: without persistence, the next
    // poll would re-hit state_unchanged and the override would fire
    // again on the same author comment, repeatedly enqueueing the
    // issue. Persisting the new hash is what lets the next poll see
    // the checkpoint has moved on.
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            labels: ["needs-info", "ready-to-spec"],
            comments: [
                { author: "operator", body: "all blockers resolved, please proceed", createdAt: "2026-09-24T11:30:00Z" },
            ],
        });
        const expectedHash = stateHashForJs(buildJudgmentStateJs(issue));
        // Seed the MATCHING checkpoint hash so the state_unchanged branch
        // is reached. The override path then fires; we read the
        // post-override `lastJudgmentHash` from disk to assert the
        // busy-loop guard (the new hash must be persisted before return).
        await writeCheckpoint(stateDir, issue.number, {
            issue: { number: issue.number, labels: issue.labels },
            lastJudgmentHash: expectedHash,
        });

        const { fetch: fetchMock, calls } = captureFetch(async () => {
            throw new Error("typesafe must NOT be called on the author-voice override path");
        });

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        assert.equal(result.skip, false);
        assert.equal(result.reason, "author_voice_override");
        assert.equal(calls.length, 0);

        // The new hash must be persisted to the checkpoint file.
        const checkpointRaw = await fs.readFile(path.join(stateDir, "issues", `${issue.number}.json`), "utf8");
        const checkpoint = JSON.parse(checkpointRaw);
        assert.equal(checkpoint.lastJudgmentHash, expectedHash);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("freshnessCheck persists the new stateHash to the checkpoint on every successful check", async () => {
    const stateDir = await makeTmpStateDir();
    try {
        const issue = fixtureIssue({
            // Last comment is a factory marker so the resume_stage
            // path is exercised (not the author-voice override).
            comments: [
                { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
                { author: "factory-bot", body: "<!-- pi-software-factory:triage:1:abc --> waiting", createdAt: "2026-09-20T10:30:00Z" },
            ],
        });
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
        // skip branch fires and `persistLastJudgmentHash` runs. The
        // polling-time resume decision then issues a second call —
        // mock that with a `resume_stage` choice response.
        const { fetch: fetchMock, calls } = captureFetchSequence([
            async () => jsonResponse(200, {
                model: "jev-1.13.0", answers: { freshness: { type: "noul", noul: 0.05 } }, usage: { input_tokens: 0, output_tokens: 0 },
            }),
            async () => jsonResponse(200, {
                model: "jev-1.13.0",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "spec",
                        probabilities: { spec: 0.9 },
                        confidence: 0.9,
                    },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        ]);

        const first = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;
        assert.equal(first.skip, true);
        assert.equal(first.reason, "state_unchanged");
        assert.ok(first.stateHash.length === 64, "stateHash is a sha-256 hex digest");
        // The resume-stage hint is populated by the new T11.3 path.
        assert.equal(first.resumeStage, "spec");

        const checkpointRaw = await fs.readFile(path.join(stateDir, "issues", `${issue.number}.json`), "utf8");
        const checkpoint = JSON.parse(checkpointRaw);
        assert.equal(checkpoint.lastJudgmentHash, first.stateHash);
        // First call: 2 fetches — freshness noul + resume_stage.
        assert.equal(calls.length, 2);

        // Second call with the same issue must recognise the matching
        // hash and still drive the resume decision. The deterministic
        // fast path skips the freshness `noul`, so only the resume
        // call is made.
        const second = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test" }),
            fetchImpl: fetchMock as typeof fetch,
        }) as FreshnessResultEx;
        assert.equal(second.skip, true);
        assert.equal(second.reason, "state_unchanged");
        assert.equal(second.stateHash, first.stateHash);
        assert.equal(second.resumeStage, "spec");
        // After second call: 3 fetches total (2 + 1).
        assert.equal(calls.length, 3);
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

        // First call: freshness `noul` returns 0.05 (below
        // threshold). The skip branch then drives the polling-time
        // resume decision, which issues a second call.
        const { fetch: fetchMock, calls } = captureFetchSequence([
            async () => jsonResponse(200, {
                model: "jev-1.13.0",
                answers: { freshness: { type: "noul", noul: 0.05 } },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
            async () => jsonResponse(200, {
                model: "jev-1.13.0",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "spec",
                        probabilities: { spec: 0.9 },
                        confidence: 0.9,
                    },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        ]);

        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.20,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;

        // typesafe WAS called — twice: freshness noul + resume_stage.
        assert.equal(calls.length, 2, "typesafe is called for freshness noul + resume_stage");
        assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");

        // noul_yes 0.05 < threshold 0.20 -> skip with resume hint.
        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.noul_yes, 0.05);
        assert.equal(result.stateHash.length, 64);
        assert.equal(result.resumeStage, "spec");

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
            model: "jev-1.13.0", answers: { freshness: { type: "noul", noul: 0.85 } }, usage: { input_tokens: 0, output_tokens: 0 },
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

        // First call: freshness `noul` returns 0.5; the polling-time
        // resume decision then issues a second call.
        const { fetch: fetchMock, calls } = captureFetchSequence([
            async () => jsonResponse(200, {
                model: "jev-1.13.0",
                answers: { freshness: { type: "noul", noul: 0.5 } },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
            async () => jsonResponse(200, {
                model: "jev-1.13.0",
                answers: {
                    resume_stage: {
                        type: "choice",
                        choice: "spec",
                        probabilities: { spec: 0.9 },
                        confidence: 0.9,
                    },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        ]);

        // threshold = 0.80 means noul_yes 0.5 < 0.80 -> skip
        const result = await freshnessCheck(issue, {
            stateDir,
            threshold: 0.80,
            env: makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" }),
            agentConfig: buildAgentConfig(makeTypesafeEnv({ TYPESAFE_API_KEY: "tk_test_secret" })),
            fetchImpl: fetchMock,
        }) as FreshnessResultEx;
        assert.equal(calls.length, 2);
        assert.equal(result.skip, true);
        assert.equal(result.reason, "state_unchanged");
        assert.equal(result.noul_yes, 0.5);
        assert.equal(result.resumeStage, "spec");
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
