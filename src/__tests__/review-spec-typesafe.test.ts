/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.2 acceptance —
 * `src/agents/review-spec.ts` `typesafe` batch (B4, B5).
 *
 * Coverage map (mirrors the acceptance bullet in `plan.md` §4 T9.2 and
 * `requirements.md` §"Decision Inventory → B"):
 *
 *   - `buildReviewSpecTypesafeRequest` composes ONE batch carrying
 *     `{ B4: Choice, B5-<findingId>: Choice × M }` over the shared
 *     `JudgmentState`, with `specBody` populated. M findings ⇒ `1 + M`
 *     primitives in a SINGLE `primitives[]` array — never M round-trips.
 *   - `parseReviewSpecTypesafeAnswer` maps the response into a
 *     `ReviewSpecTypesafeBatchAnswer` with a mean confidence; a missing
 *     or malformed B4 returns null (parse miss → fallback); malformed
 *     B5 entries are dropped without aborting.
 *   - `ReviewSpecAgent.run()` enriches the `SpecReviewResult` with
 *     `confidence` + `typesafeBatch` on a 200 response, and falls back
 *     silently to the existing `parseSpecReviewResult()` (claude-code)
 *     output on `format-error` or an unreachable endpoint (HTTP 500 →
 *     synthetic CJK fallback envelope).
 *   - The batch is ONE outbound HTTP request. We assert the mocked
 *     `globalThis.fetch` is called exactly once per `run()`.
 *
 * The narrative path is driven through the `ReviewSpecAgent`'s injected
 * `runtimeOverride` (no real CLI); the typesafe adapter is driven
 * through a mocked `globalThis.fetch` (no real network).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    ReviewSpecAgent,
    buildReviewSpecJudgmentState,
    buildReviewSpecTypesafeRequest,
    parseReviewSpecTypesafeAnswer,
} from "../agents/review-spec.js";
import type {
    AgentRuntime,
    StageRunRequest,
    StageRunResult,
} from "../core/agent-runtime.js";
import type { AgentContext, Finding, SpecReviewResult } from "../core/types.js";
import { buildJudgmentState } from "../core/judgment-state.js";
import { runTypesafeStageFromConfig } from "../../runtime/typesafe-backend.mjs";
import { resolveAgentConfig } from "../../runtime/agent-backends.mjs";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeContext(workdir: string): AgentContext {
    const logger = {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() { return this; },
    };
    return {
        repo: { owner: "o", name: "n", defaultBranch: "main", workdir },
        issue: {
            number: 7,
            title: "Review spec typesafe test",
            body: "Body for review-spec typesafe test.",
            labels: ["ready-to-spec"],
            author: "tester",
            url: "https://example.com/7",
            createdAt: "2026-09-20T10:00:00.000Z",
            comments: [],
        },
        skills: [],
        skillsRoot: "/tmp",
        runId: "review-spec-typesafe-run",
        logger: logger as unknown as AgentContext["logger"],
    } as unknown as AgentContext;
}

/**
 * Materialise the four review artifacts `ReviewSpecAgent.run()` reads
 * from `FACTORY_REVIEW_DIR`. Returns the directory path.
 */
function makeReviewDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "factory-review-spec-typesafe-"));
    writeFileSync(path.join(dir, "spec_diff.txt"), "+++ b/specs/x/PRODUCT.md\n[NEW:1] ## Acceptance criteria\n", "utf8");
    writeFileSync(
        path.join(dir, "spec_product.md"),
        "# PRODUCT.md\n\n## Acceptance criteria\n\n- AC-1 first criterion\n- AC-2 second criterion\n",
        "utf8",
    );
    writeFileSync(
        path.join(dir, "spec_tech.md"),
        "# TECH.md\n\n## Validation plan\n\n- VP-1 npm test\n",
        "utf8",
    );
    writeFileSync(path.join(dir, "spec_description.txt"), "Spec PR description.", "utf8");
    return dir;
}

/**
 * Canned review-spec LLM output. The two severity markers in `body` are
 * translated into two structured findings by `parseSpecReviewResult`,
 * which gives the B5 batch M = 2 findings to grade.
 */
const REVIEW_OUTPUT = JSON.stringify({
    verdict: "REJECT",
    body:
        "Found: 1 critical, 1 important, 0 suggestions, 0 nits.\n\n" +
        "- **[CRITICAL]** AC-1 is not observable from behaviour.\n" +
        "- **[IMPORTANT]** AC-2 lacks a migration plan.",
    notes: "Cross-document consistency is otherwise fine.",
    comments: [],
});

/** Fake runtime answering the review-spec role with canned JSON. */
function fakeRuntime(): AgentRuntime & { calls: StageRunRequest[] } {
    const calls: StageRunRequest[] = [];
    const runtime: AgentRuntime = {
        selectBackend() {
            return {
                selection: { backend: "claude-code" },
                log: { backend: "claude-code", source: "default" },
            };
        },
        describeBackend(id) {
            return {
                id,
                displayName: "fake-claude",
                capabilities: { readOnly: true },
                schemaVersion: 1,
                buildHash: "test",
            };
        },
        async runStage(request: StageRunRequest): Promise<StageRunResult> {
            calls.push(request);
            return {
                status: "succeeded",
                output: REVIEW_OUTPUT,
                usage: null,
                logTail: "",
                backend: "claude-code",
                warnings: [],
                retryable: false,
                providerSessionId: "fake-review-spec",
            };
        },
    };
    return Object.assign(runtime, { calls });
}

/**
 * Echo-style typesafe mock: answers every requested primitive so the
 * response ids always line up with the request (finding ids are UUIDs
 * minted at parse time and cannot be hard-coded).
 */
async function echoTypesafeResponse(
    _input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const request = JSON.parse(String(init?.body)) as {
        questions: Record<string, { type: string }>;
    };
    const answers: Record<string, { type: string } & Record<string, unknown>> = {};
    for (const id of Object.keys(request.questions ?? {})) {
        if (id === "B4") {
            answers.B4 = {
                type: "choice",
                choice: "REJECT",
                probabilities: { APPROVE: 0.1, REJECT: 0.9 },
                confidence: 0.9,
            };
        } else {
            // B5-<findingId> — pick `blocking` to match the legacy mock.
            answers[id] = {
                type: "choice",
                choice: "blocking",
                probabilities: { blocking: 0.8, important: 0.1, suggestion: 0.05, nit: 0.05 },
                confidence: 0.8,
            };
        }
    }
    return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: "ts-review-1",
    }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

/**
 * Run `fn` with `globalThis.fetch` mocked, `FACTORY_REVIEW_DIR` pointed
 * at a fresh artifact directory, and the typesafe env reachable. All
 * globals are restored afterwards.
 */
async function withReviewSpecStubs<T>(
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    fn: (opts: {
        reviewDir: string;
        calls: Array<{ url: string; body: unknown }>;
    }) => Promise<T>,
): Promise<T> {
    const reviewDir = makeReviewDir();
    const calls: Array<{ url: string; body: unknown }> = [];
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.TYPESAFE_API_KEY;
    const previousOff = process.env.FACTORY_TYPESAFE_OFF;
    const previousReviewDir = process.env.FACTORY_REVIEW_DIR;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        let parsedBody: unknown = init?.body;
        if (typeof parsedBody === "string") {
            try { parsedBody = JSON.parse(parsedBody); } catch { /* keep as string */ }
        }
        calls.push({ url: typeof input === "string" ? input : input.toString(), body: parsedBody });
        return fetchImpl(input, init);
    }) as typeof fetch;
    process.env.TYPESAFE_API_KEY = "tk_test_secret";
    delete process.env.FACTORY_TYPESAFE_OFF;
    process.env.FACTORY_REVIEW_DIR = reviewDir;
    try {
        return await fn({ reviewDir, calls });
    } finally {
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = previousKey;
        if (previousOff === undefined) delete process.env.FACTORY_TYPESAFE_OFF;
        else process.env.FACTORY_TYPESAFE_OFF = previousOff;
        if (previousReviewDir === undefined) delete process.env.FACTORY_REVIEW_DIR;
        else process.env.FACTORY_REVIEW_DIR = previousReviewDir;
        rmSync(reviewDir, { recursive: true, force: true });
    }
}

/** Build M findings with stable ids for the pure-helper tests. */
function makeFindings(count: number): Finding[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `F-${i + 1}`,
        ruleId: `rule-${i + 1}`,
        severity: "blocking" as const,
        requirementIds: [`AC-${i + 1}`],
        summary: `finding ${i + 1}`,
        evidence: {},
        sourceStage: "review-spec",
        sourceRunId: "run-1",
        registeredAt: "2026-09-20T10:00:00.000Z",
        status: "open" as const,
    }));
}

/* -------------------------------------------------------------------------- */
/* buildReviewSpecJudgmentState                                               */
/* -------------------------------------------------------------------------- */

test("buildReviewSpecJudgmentState populates specBody from the review body", () => {
    const reviewDir = makeReviewDir();
    try {
        const ctx = makeContext(reviewDir);
        const review = { verdict: "REJECT", body: "the spec body under review", comments: [], notes: "" } as SpecReviewResult;
        const state = buildReviewSpecJudgmentState(ctx, review);
        assert.equal(state.specBody, "the spec body under review");
        assert.equal(state.issue.number, 7);
    } finally {
        rmSync(reviewDir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* buildReviewSpecTypesafeRequest — ONE batch, 1 + M primitives               */
/* -------------------------------------------------------------------------- */

test("buildReviewSpecTypesafeRequest emits ONE batch with B4 + M severity questions over a shared state", () => {
    const reviewDir = makeReviewDir();
    try {
        const state = buildJudgmentState(makeContext(reviewDir).issue, undefined, { specBody: "# SPEC" });
        const findings = makeFindings(3);
        const request = buildReviewSpecTypesafeRequest(state, findings);

        assert.ok(!("state_hash" in request), "state_hash must not travel on the wire");
        assert.equal(typeof request.state, "object");
        assert.deepEqual(request.state, state);
        assert.equal(request.state.specBody, "# SPEC");
        // 1 (B4) + 3 (B5 per finding) = 4 questions in ONE request.
        assert.equal(Object.keys(request.questions).length, 4);
        assert.deepEqual(
            Object.keys(request.questions),
            ["B4", "B5-F-1", "B5-F-2", "B5-F-3"],
        );
        assert.equal(request.questions.B4.type, "choice");
        assert.match(String(request.questions.B4.instructions), /APPROVE|REJECT/);
        assert.equal(request.questions["B5-F-1"].type, "choice");
    } finally {
        rmSync(reviewDir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* parseReviewSpecTypesafeAnswer                                              */
/* -------------------------------------------------------------------------- */

test("parseReviewSpecTypesafeAnswer maps a valid response into a typed answer with meanConfidence", () => {
    const findings = makeFindings(2);
    const answer = parseReviewSpecTypesafeAnswer(
        [
            { id: "B4", value: "REJECT", confidence: 0.9 },
            { id: "B5-F-1", value: "blocking", confidence: 0.8 },
            { id: "B5-F-2", value: "important", confidence: 0.7 },
        ],
        findings,
    );
    assert.ok(answer);
    assert.equal(answer!.b4.value, "REJECT");
    assert.equal(answer!.b5.length, 2);
    assert.equal(answer!.b5[0].findingId, "F-1");
    assert.equal(answer!.b5[1].value, "important");
    const expectedMean = (0.9 + 0.8 + 0.7) / 3;
    assert.ok(Math.abs(answer!.meanConfidence - expectedMean) < 1e-9);
});

test("parseReviewSpecTypesafeAnswer returns null when B4 is missing or malformed", () => {
    const findings = makeFindings(1);
    // Missing B4.
    assert.equal(
        parseReviewSpecTypesafeAnswer([{ id: "B5-F-1", value: "blocking", confidence: 0.8 }], findings),
        null,
    );
    // B4 value outside the verdict vocabulary.
    assert.equal(
        parseReviewSpecTypesafeAnswer([{ id: "B4", value: "MAYBE", confidence: 0.8 }], findings),
        null,
    );
    // Unusable envelope.
    assert.equal(parseReviewSpecTypesafeAnswer(null, findings), null);
    assert.equal(parseReviewSpecTypesafeAnswer([], findings), null);
});

test("parseReviewSpecTypesafeAnswer drops malformed B5 entries without aborting", () => {
    const findings = makeFindings(2);
    const answer = parseReviewSpecTypesafeAnswer(
        [
            { id: "B4", value: "APPROVE", confidence: 0.9 },
            // Unknown severity vocabulary — dropped.
            { id: "B5-F-1", value: "catastrophic", confidence: 0.8 },
            // Well-formed — kept.
            { id: "B5-F-2", value: "nit", confidence: 0.6 },
        ],
        findings,
    );
    assert.ok(answer);
    assert.equal(answer!.b5.length, 1);
    assert.equal(answer!.b5[0].findingId, "F-2");
    const expectedMean = (0.9 + 0.6) / 2;
    assert.ok(Math.abs(answer!.meanConfidence - expectedMean) < 1e-9);
});

/* -------------------------------------------------------------------------- */
/* ReviewSpecAgent.run — happy / format-error / unreachable / one-request     */
/* -------------------------------------------------------------------------- */

test("ReviewSpecAgent.run attaches the typesafe answer on a 200 response (happy path)", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "factory-review-spec-wd-"));
    try {
        await withReviewSpecStubs(echoTypesafeResponse, async ({ calls }) => {
            const runtime = fakeRuntime();
            const agent = new ReviewSpecAgent(makeContext(workdir), runtime);
            const review = await agent.run();

            // The claude-code verdict survives untouched.
            assert.equal(review.verdict, "REJECT");
            assert.ok(review.findings && review.findings.length === 2);
            // T9.2 enrichment.
            assert.ok(review.confidence !== undefined, "confidence populated on success");
            assert.ok(review.typesafeBatch !== undefined, "typesafeBatch populated on success");
            assert.equal(review.typesafeBatch!.b4.value, "REJECT");
            assert.equal(review.typesafeBatch!.b5.length, 2);
            // Headline confidence = B4's (the verdict primitive), NOT
            // the mixed-primitive mean — semantically incompatible to
            // average yes-probability with distribution concentration.
            assert.ok(Math.abs(review.confidence! - 0.9) < 1e-9);

            // Exactly ONE outbound HTTP request — the batch, not M.
            assert.equal(calls.length, 1, "the typesafe batch must be ONE HTTP request");
            assert.match(calls[0].url, /api\.typesafe\.ai\/v1\/systemone/);
            // 1 (B4) + 2 (B5 per finding) questions in that one request.
            const body = calls[0].body as { state: { specBody?: string }; questions: Record<string, unknown> };
            assert.equal(Object.keys(body.questions).length, 3);
            assert.ok("B4" in body.questions);
            // The spec body is available on the shared state.
            assert.equal(body.state.specBody, review.body);
            // The narrative path ran through the fake runtime once.
            assert.equal(runtime.calls.length, 1);
        });
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("ReviewSpecAgent.run falls back to the claude-code path on a typesafe format-error", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "factory-review-spec-wd-"));
    try {
        await withReviewSpecStubs(
            // 200 but non-JSON → the adapter maps it to the CJK fallback
            // envelope → parse miss → the parsed claude-code verdict is
            // returned without enrichment.
            async () => new Response("<html>oops</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            }),
            async ({ calls }) => {
                const runtime = fakeRuntime();
                const agent = new ReviewSpecAgent(makeContext(workdir), runtime);
                const review = await agent.run();

                assert.equal(review.verdict, "REJECT");
                assert.ok(review.findings && review.findings.length === 2);
                assert.equal(review.confidence, undefined);
                assert.equal(review.typesafeBatch, undefined);
                assert.equal(calls.length, 1);
            },
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("ReviewSpecAgent.run returns the synthetic fallback shape when typesafe is unreachable (HTTP 500)", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "factory-review-spec-wd-"));
    try {
        await withReviewSpecStubs(
            async () => new Response("upstream down", { status: 500 }),
            async () => {
                // Adapter-level: the synthetic CJK fallback envelope per
                // requirements.md §"CJK Fallback Contract".
                const state = buildJudgmentState(makeContext(workdir).issue, undefined, { specBody: "# SPEC" });
                const request = buildReviewSpecTypesafeRequest(state, makeFindings(1));
                const envelope = await runTypesafeStageFromConfig(
                    resolveAgentConfig(process.env),
                    "typesafe",
                    request,
                    { env: process.env },
                );
                assert.equal(envelope.status, "failed");
                assert.equal(envelope.backend, "typesafe");
                assert.equal(envelope.retryable, false);
                assert.equal(envelope.providerSessionId, null);
                assert.match(envelope.warnings[0], /typesafe_fallback_to_claude: http 500/);

                // Agent-level: the verdict still comes back from the
                // claude-code fallback path, unenriched.
                const runtime = fakeRuntime();
                const agent = new ReviewSpecAgent(makeContext(workdir), runtime);
                const review = await agent.run();
                assert.equal(review.verdict, "REJECT");
                assert.equal(review.confidence, undefined);
                assert.equal(review.typesafeBatch, undefined);
            },
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("ReviewSpecAgent.run sends exactly ONE typesafe request regardless of M findings", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "factory-review-spec-wd-"));
    try {
        await withReviewSpecStubs(echoTypesafeResponse, async ({ calls }) => {
            const runtime = fakeRuntime();
            const agent = new ReviewSpecAgent(makeContext(workdir), runtime);
            const review = await agent.run();

            assert.equal(calls.length, 1, "batch must be ONE HTTP request, not M");
            const body = calls[0].body as { questions: Record<string, unknown> };
            // 1 (B4) + M (B5) — M is the finding count the parser emitted.
            const m = review.findings?.length ?? 0;
            assert.ok(m > 0, "fixture must produce at least one finding");
            assert.equal(Object.keys(body.questions).length, 1 + m);
        });
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});