/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.1 acceptance tests
 * (verify-behavior half — B9 + B11).
 *
 * 2026-09-22 execute-then-judge fix: the claude-code executor now
 * ALWAYS runs first and produces the real verification (status,
 * channel, notes, parsed checks + receipts). The typesafe batch is
 * a JUDGMENT layer over that executed evidence:
 *
 *   1. The batch carries B9 (status Choice across the executed
 *      receipts + checks) and ONE B11 per REAL check (keyed
 *      `B11-<index>`, no fixed-slot conflation of "absent" with
 *      "failed"). Receipts travel on
 *      `JudgmentState.factory.lastReceiptRegistry`; checks travel
 *      on the new `verificationChecks` slice.
 *   2. B9 below `VERIFY_JUDGMENT_CONFIDENCE_FLOOR` is advisory; at
 *      or above the floor a positive claim (`verified` /
 *      `confirmed`) is DOWNGRADED to Jev's negative status (the
 *      executed status never upgrades).
 *   3. ANY typesafe failure (parse miss, unreachable, off-toggle)
 *      leaves the executed result standing UNJUDGED — no synthetic
 *      `blocked`. The CJK contract's `fallback_backend: claude-code`
 *      is now real because claude-code already produced the result.
 *
 * B10 was removed (channel is an exact lookup over receipt kinds
 * and belongs in code, not in Jev). The tests below use the
 * `setVerifyBehaviorGenerationOverrideForTest` seam to stub the
 * executor so the judgment layer can be exercised without a real
 * CLI / browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { __clearAgentRuntimeCacheForTest } from "../core/agent-runtime.js";
import {
    VerifyBehaviorAgent,
    consumeReceiptRegistry,
    setVerifyBehaviorFetchImpl,
    setVerifyBehaviorGenerationOverrideForTest,
    deriveChannelFromReceipts,
    parseVerifyTypesafeAnswer,
    issueAppearsUi,
    receiptCheckSupported,
    receiptJudgmentDetail,
    type GenerationOutcome,
    type VerificationCheck,
} from "../agents/verify-behavior.js";
import type { AgentContext, BehaviorVerificationResult, Issue } from "../core/types.js";

test('explicitly negative UI verification wording does not invent a UI surface', () => {
    assert.equal(issueAppearsUi({ ...fixtureIssue(), title: 'Document CLI quickstart', body: 'This is a docs-only change with no UI verification requirement.' }), false);
    assert.equal(issueAppearsUi({ ...fixtureIssue(), title: 'CLI 文档', body: '无需浏览器验证。' }), false);
    assert.equal(issueAppearsUi({ ...fixtureIssue(), title: 'Add Archive button', body: 'No UI verification required.' }), true);
    assert.equal(issueAppearsUi({ ...fixtureIssue(), title: 'Add dashboard', body: 'Add a filter button with no UI verification requirement.' }), true);
});

test('acceptance registration rejects unknown and failed receipts, including raw expected errors', () => {
    const receipts = [{ id: 'passing-assertion', passed: true }, { id: 'raw-cli-error', passed: false }];
    const check = { criterion: 'Existing destination is rejected with the expected error', passed: true, receiptIds: ['passing-assertion'] };
    assert.equal(receiptCheckSupported(check, receipts), true);
    assert.equal(receiptCheckSupported({ ...check, receiptIds: ['raw-cli-error'] }, receipts), false);
    assert.equal(receiptCheckSupported({ ...check, receiptIds: ['unknown'] }, receipts), false);
    assert.equal(receiptCheckSupported({ ...check, receiptIds: [] }, receipts), false);
    assert.equal(receiptCheckSupported({ ...check, passed: false }, receipts), false);
});

test('Jev receipt evidence retains execution outcomes after long commands', () => {
    const detail = receiptJudgmentDetail({ command: 'x'.repeat(5000), exitCode: 0, stdout: 'AC-4 passed', stderr: '' }) as any;
    assert.equal(detail.exitCode, 0);
    assert.equal(detail.stdout, 'AC-4 passed');
    assert.equal(detail.stderr, '');
    assert.equal(detail.command.truncated, true);
    assert.equal(detail.command.originalLength, 5000);
    assert.equal(detail.command.excerpt.length, 2000);
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function fixtureIssue(): Issue {
    return {
        number: 77,
        title: "Archive completed tasks",
        body: "AC-1: the Archive button appears. AC-2: completed tasks disappear.",
        labels: ["ready-to-merge"],
        author: "operator",
        url: "https://example.com/77",
        createdAt: "",
        comments: [],
    };
}

function fixtureContext(workdir: string): AgentContext {
    return {
        repo: {
            owner: "acme",
            name: "factory",
            defaultBranch: "main",
            workdir,
        },
        issue: fixtureIssue(),
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {},
            child() {
                return this;
            },
        },
        skills: [],
        skillsRoot: workdir,
        runId: "run-test-77",
    } as unknown as AgentContext;
}

function useEnv(vars: Record<string, string>): () => void {
    const saved: Record<string, string | undefined> = {};
    const merged: Record<string, string> = {
        FACTORY_CLAUDE_COMMAND: "factory-test-missing-claude-binary",
        ...vars,
    };
    for (const [key, value] of Object.entries(merged)) {
        saved[key] = process.env[key];
        process.env[key] = value;
    }
    __clearAgentRuntimeCacheForTest();
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        __clearAgentRuntimeCacheForTest();
    };
}

function captureFetch(
    impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = (init ?? {}) as RequestInit;
        let parsedBody: unknown = req.body;
        if (typeof req.body === "string") {
            try {
                parsedBody = JSON.parse(req.body);
            } catch {
                /* keep as string */
            }
        }
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            body: parsedBody,
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

function executedOutcome(
    status: BehaviorVerificationResult["status"],
    channel: BehaviorVerificationResult["channel"],
    notes: string,
    checks: VerificationCheck[],
): GenerationOutcome {
    return {
        result: {
            mode: "verify",
            status,
            channel,
            ozRunUrl: "https://oz.warp.dev/runs/run-test-77",
            evidence: [],
            notes,
        },
        checks,
    };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

test("deriveChannelFromReceipts encodes the channel as a kind-based lookup", () => {
    assert.equal(
        deriveChannelFromReceipts([{ kind: "browser-assertion" }]),
        "browser",
    );
    assert.equal(
        deriveChannelFromReceipts([{ kind: "operator-test" }]),
        "desktop",
    );
    assert.equal(
        deriveChannelFromReceipts([
            { kind: "browser-assertion" },
            { kind: "test" },
        ]),
        "hybrid",
    );
    assert.equal(
        deriveChannelFromReceipts([]),
        "desktop",
    );
});

test("parseVerifyTypesafeAnswer: missing/malformed B9 is a parse miss (no silent blocked)", () => {
    // Empty array.
    assert.equal(parseVerifyTypesafeAnswer([], 0), null);
    // B9 missing.
    assert.equal(
        parseVerifyTypesafeAnswer(
            [{ id: "B11-0", value: true, confidence: 0.9 }],
            1,
        ),
        null,
    );
    // B9 value out of vocabulary — must NOT collapse to "blocked".
    assert.equal(
        parseVerifyTypesafeAnswer(
            [{ id: "B9", value: "kinda-verified", confidence: 0.9 }],
            0,
        ),
        null,
    );
    // B9 confidence non-finite.
    assert.equal(
        parseVerifyTypesafeAnswer(
            [{ id: "B9", value: "verified", confidence: NaN }],
            0,
        ),
        null,
    );
});

test("parseVerifyTypesafeAnswer: valid B9 + per-check B11 yields the expected map", () => {
    const judgment = parseVerifyTypesafeAnswer(
        [
            { id: "B9", value: "verified", confidence: 0.93 },
            { id: "B11-0", value: true, confidence: 0.9 },
            { id: "B11-1", value: true, confidence: 0.8 },
            // B11-2 absent — that check is simply not in the map.
            // B11-3 false — its raw noul probability IS captured so
            // the consumer can compare with the agent's `passed`
            // claim regardless of direction.
            { id: "B11-3", value: false, confidence: 0.7 },
        ],
        4,
    );
    assert.ok(judgment);
    assert.equal(judgment!.b9?.value, "verified");
    assert.equal(judgment!.b9?.confidence, 0.93);
    assert.equal(judgment!.b11.size, 3);
    assert.equal(judgment!.b11.get(0), 0.9);
    assert.equal(judgment!.b11.get(1), 0.8);
    assert.equal(judgment!.b11.get(3), 0.7);
});

/* -------------------------------------------------------------------------- */
/* Happy path: execute-then-judge sends one batch with the executed evidence   */
/* -------------------------------------------------------------------------- */

test("judgment batch carries the executed receipts + checks on one shared state", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        // The operator regression command produces a `passed:true`
        // receipt before the executor runs — the receipt registry
        // and the channel derivation both depend on it.
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    const checks: VerificationCheck[] = [
        { criterion: "Archive button is visible", passed: true, receiptIds: ["op"] },
        { criterion: "Completed tasks disappear", passed: true, receiptIds: ["op"] },
    ];
    setVerifyBehaviorGenerationOverrideForTest(async () => executedOutcome("verified", "browser", "ran OK", checks));
    try {
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, {
                model: "jev-1.13.0",
                answers: {
                    B9: { type: "choice", choice: "verified", probabilities: { verified: 0.93 }, confidence: 0.93 },
                    "B11-0": { type: "noul", noul: 0.9 },
                    "B11-1": { type: "noul", noul: 0.9 },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const agent = new VerifyBehaviorAgent(ctx, "verify");
            const result = await agent.run();
            assert.equal(result.status, "verified");
            // Channel is derived from the operator-test receipt (not
            // from the executed "browser" claim): the code-correct
            // value wins.
            assert.equal(result.channel, "desktop");
            assert.equal(result.mode, "verify");
            assert.equal(result.ozRunUrl, "https://oz.warp.dev/runs/run-test-77");
            assert.equal(result.checks?.length, 2);

            // Exactly ONE batch request: B9 + one B11 per REAL check
            // (no B10, no fixed slots).
            assert.equal(calls.length, 1, "exactly one typesafe batch call");
            const body = calls[0].body as {
                questions: Record<string, { type: string }>;
                state: Record<string, unknown>;
            };
            const ids = Object.keys(body.questions);
            assert.deepEqual(ids.sort(), ["B11-0", "B11-1", "B9"]);
            assert.equal(body.questions["B9"].type, "choice");
            assert.equal(body.questions["B11-0"].type, "noul");
            // State carries the executed receipts (registry) and the
            // checks slice so B9 / B11 can judge them.
            const stateJson = JSON.stringify(body.state);
            assert.ok(stateJson.includes("Archive completed tasks"), "state carries the issue body");
            assert.ok(stateJson.includes("Archive button is visible"), "state carries the executed checks");
            assert.ok(stateJson.includes("operator-test"), "state carries the receipt kinds");

            // The receipt registry is still published for the
            // orchestrator (ground truth survives the judgment layer).
            const registry = consumeReceiptRegistry();
            assert.ok(registry);
            assert.equal(registry?.mode, "verify");
            assert.ok((registry?.receipts.length ?? 0) >= 1);
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("high-confidence B9 downgrades an overclaimed verified to not-verified", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    const checks: VerificationCheck[] = [
        { criterion: "button appears", passed: true, receiptIds: ["op"] },
    ];
    setVerifyBehaviorGenerationOverrideForTest(async () => executedOutcome("verified", "desktop", "I think it works", checks));
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, {
                model: "jev-1.13.13",
                answers: {
                    B9: { type: "choice", choice: "not-verified", probabilities: { not_verified: 0.9 }, confidence: 0.9 },
                    "B11-0": { type: "noul", noul: 0.4 },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            assert.equal(result.status, "not-verified", "high-confidence B9 must downgrade the overclaim");
            assert.match(result.notes, /downgraded status/);
            assert.match(result.notes, /verified → not-verified/);
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("low-confidence B9 disagreement keeps the executed status with an advisory note", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    setVerifyBehaviorGenerationOverrideForTest(async () => executedOutcome("verified", "desktop", "ran", [
        { criterion: "criterion 1", passed: true, receiptIds: ["op"] },
    ]));
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, {
                model: "jev-1.13.13",
                answers: {
                    B9: { type: "choice", choice: "not-verified", probabilities: { not_verified: 0.6 }, confidence: 0.4 },
                    "B11-0": { type: "noul", noul: 0.2 },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            assert.equal(result.status, "verified", "below the floor the executed status stands");
            assert.match(result.notes, /low-confidence/);
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("B11 disagreement on a single check is attributed to that criterion (not blanket)", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    setVerifyBehaviorGenerationOverrideForTest(async () => executedOutcome("verified", "desktop", "ran", [
        { criterion: "real criterion", passed: true, receiptIds: ["op"] },
        { criterion: "fake claim", passed: true, receiptIds: ["op"] },
    ]));
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, {
                model: "jev-1.13.13",
                answers: {
                    B9: { type: "choice", choice: "verified", probabilities: { verified: 0.95 }, confidence: 0.95 },
                    "B11-0": { type: "noul", noul: 0.9 },
                    // Only check 1 is judged insufficient.
                    "B11-1": { type: "noul", noul: 0.2 },
                },
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            // The per-check disagreement is attributed to the exact
            // criterion (the old "any B11 false + any passed receipt"
            // blanket note is no longer possible).
            assert.match(result.notes, /"fake claim"/);
            assert.doesNotMatch(result.notes, /"real criterion"/);
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Failure paths — the executed result always survives                         */
/* -------------------------------------------------------------------------- */

test("batch parse miss (empty answers): executed result stands unjudged, no synthetic blocked", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    const executed = executedOutcome("verified", "desktop", "executor verdict", [
        { criterion: "criterion 1", passed: true, receiptIds: ["op"] },
    ]);
    setVerifyBehaviorGenerationOverrideForTest(async () => structuredClone(executed));
    try {
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, { model: "jev-1.13.13", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            // The executed result survives verbatim (the synthetic
            // `blocked` fallback that used to lie about "falling
            // back to claude-code" while never calling it is gone).
            assert.deepEqual(result, { ...executed.result, checks: executed.checks });
            assert.equal(calls.length, 1, "typesafe adapter was hit once before the parse-miss decision");
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("typesafe unreachable (mock fetch → 500): executed result stands unjudged (no synthetic blocked)", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    const executed = executedOutcome("verified", "desktop", "executor verdict", [
        { criterion: "criterion 1", passed: true, receiptIds: ["op"] },
    ]);
    setVerifyBehaviorGenerationOverrideForTest(async () => structuredClone(executed));
    try {
        const { fetch: fetchMock, calls } = captureFetch(
            async () => new Response("upstream down", { status: 500 }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            // The outage degrades the JUDGMENT, never the result: no
            // synthetic blocked, no http-500 breadcrumb in notes.
            assert.deepEqual(result, { ...executed.result, checks: executed.checks });
            assert.doesNotMatch(result.notes, /http 500/);
            assert.equal(calls.length, 1);
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("FACTORY_TYPESAFE_OFF=1: judgment skipped without hitting fetch; result unchanged", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "1",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    const executed = executedOutcome("verified", "desktop", "executor verdict", [
        { criterion: "criterion 1", passed: true, receiptIds: ["op"] },
    ]);
    setVerifyBehaviorGenerationOverrideForTest(async () => structuredClone(executed));
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            throw new Error("fetch should not have been called when FACTORY_TYPESAFE_OFF=1");
        }) as typeof fetch;
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            assert.deepEqual(result, { ...executed.result, checks: executed.checks });
            assert.equal(fetchCalls, 0);
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test('all mapped AC checks are judged, and missing or negative B11 cannot pass', async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'verify-all-ac-'));
    const restore = useEnv({ FACTORY_AGENT_BACKEND: 'claude-code', TYPESAFE_API_KEY: 'test', FACTORY_TYPESAFE_OFF: '0' });
    const checks = Array.from({ length: 10 }, (_, index) => ({ criterion: `Criterion ${index + 1}`,
        requirementIds: [`AC-${index + 1}`], passed: true, receiptIds: ['receipt'] }));
    setVerifyBehaviorGenerationOverrideForTest(async () => executedOutcome('verified', 'desktop', 'ran', checks));
    try {
        for (const last of [0.9, 0.1, undefined]) {
            setVerifyBehaviorFetchImpl((async (_url: any, options: any) => {
                const request = JSON.parse(options.body);
                assert.equal(Object.keys(request.questions).length, 11);
                const answers: Record<string, unknown> = {
                    B9: { type: 'choice', choice: 'verified', probabilities: { verified: 0.93 }, confidence: 0.93 },
                };
                for (let index = 0; index < 10; index++) {
                    if (index !== 9 || last !== undefined) answers[`B11-${index}`] = { type: 'noul', noul: index === 9 ? last : 0.9 };
                }
                return jsonResponse(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: 0, output_tokens: 0 } });
            }) as typeof fetch);
            const result = await new VerifyBehaviorAgent(fixtureContext(workdir), 'verify').run();
            assert.equal(result.status, last === undefined ? 'blocked' : last < 0.5 ? 'not-verified' : 'verified');
        }
    } finally {
        setVerifyBehaviorFetchImpl(null);
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("generation failure propagates (missing CLI binary): rejects, fetch not called", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    });
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            return jsonResponse(200, { model: "jev-1.13.13", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
        }) as typeof fetch;
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const agent = new VerifyBehaviorAgent(ctx, "verify");
            // No generation override: the dispatch targets the missing
            // FACTORY_CLAUDE_COMMAND binary and fails fast. Execution
            // runs FIRST now, so the judgment layer is never reached.
            await assert.rejects(() => agent.run(), /verify-behavior/);
            assert.equal(fetchCalls, 0, "judgment batch must not run when execution failed");
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* No regression for claude-code deployments                                   */
/* -------------------------------------------------------------------------- */

test("claude-code deployment (backend != typesafe): judgment layer still attempted when the API key is set", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_should_be_used_for_judgment",
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    const executed = executedOutcome("verified", "desktop", "executor verdict", [
        { criterion: "criterion 1", passed: true, receiptIds: ["op"] },
    ]);
    setVerifyBehaviorGenerationOverrideForTest(async () => structuredClone(executed));
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            return jsonResponse(200, { model: "jev-1.13.13", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
        }) as typeof fetch;
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const result = await new VerifyBehaviorAgent(ctx, "verify").run();
            // typesafe is the bypass judgment layer (not a per-role
            // backend): the empty batch is a parse miss, so the
            // executed result stands unjudged.
            assert.deepEqual(result, { ...executed.result, checks: executed.checks });
            assert.ok(fetchCalls >= 1, "typesafe judgment must be attempted whenever TYPESAFE_API_KEY is set, regardless of the role backend");
        } finally {
            setVerifyBehaviorFetchImpl(null);
        }
    } finally {
        setVerifyBehaviorGenerationOverrideForTest(null);
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});
