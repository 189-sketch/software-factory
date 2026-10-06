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
 *   3. Missing or unavailable independent judgment retains execution
 *      evidence but blocks positive semantic acceptance, including off-toggle.
 *
 * B10 was removed (channel is an exact lookup over receipt kinds
 * and belongs in code, not in Jev). The tests below use the
 * `setVerifyBehaviorGenerationOverrideForTest` seam to stub the
 * executor so the judgment layer can be exercised without a real
 * CLI / browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
    verificationJudgmentEvidence,
    buildVerificationJudgmentState,
    buildTypesafeRequest,
    operatorRegressionCheck,
    type GenerationOutcome,
    type VerificationCheck,
} from "../agents/verify-behavior.js";
import type { AgentContext, BehaviorVerificationResult, Issue, JudgmentFailure, SpecPair } from "../core/types.js";
import { evidenceDirectory } from '../../runtime/evidence-store.mjs';
import { VERIFICATION_CAPABILITY_HASH } from '../../runtime/verification-capabilities.mjs';

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
    assert.equal(receiptCheckSupported({ ...check, receiptIds: ['open'] }, [{ id: 'open', passed: true, kind: 'browser-action' }]), false);
    assert.equal(receiptCheckSupported({ ...check, receiptIds: ['open', 'assert'] }, [
        { id: 'open', passed: true, kind: 'browser-action' }, { id: 'assert', passed: true, kind: 'browser-assertion' },
    ]), true);
});

test('Jev receipt evidence retains execution outcomes after long commands', () => {
    const detail = receiptJudgmentDetail({ command: 'x'.repeat(5000), exitCode: 0, stdout: 'AC-4 passed', stderr: '' }) as any;
    assert.equal(detail.exitCode, 0);
    assert.equal(detail.stdout, 'AC-4 passed');
    assert.equal(detail.stderr, '');
    assert.equal(detail.command.truncated, true);
    assert.equal(detail.command.originalLength, 5000);
    assert.equal(detail.command.excerpt.length, 2000);
    assert.deepEqual(receiptJudgmentDetail('x'.repeat(500)), { excerpt: 'x'.repeat(400), truncated: true, originalLength: 500 });
    assert.equal(receiptJudgmentDetail(null), null);
});

test('compact evidence preserves observations and cannot turn dangling references into valid ids', () => {
    const receipts = [
        { id: 'uuid-receipt', kind: 'browser-action', passed: true,
            detail: { browserSessionId: 'session-one', previousReceiptId: 'r0', actual: 'uuid-receipt' } },
        { id: 'assertion', kind: 'browser-assertion', passed: true,
            detail: { browserSessionId: 'session-one', previousReceiptId: 'uuid-receipt', expected: 'uuid-receipt' } },
    ];
    const checks = [{ criterion: 'Observe the exact value', passed: true, receiptIds: ['assertion', 'r1'] }];
    const original = structuredClone({ receipts, checks });
    const projected = verificationJudgmentEvidence(receipts, checks);
    assert.equal(projected.receipts[0].id, '_r0');
    assert.equal(projected.receipts[1].id, '_r1');
    assert.equal((projected.receipts[0].detail as any).previousReceiptId, 'r0');
    assert.equal((projected.receipts[1].detail as any).previousReceiptId, '_r0');
    assert.equal((projected.receipts[0].detail as any).browserSessionId, (projected.receipts[1].detail as any).browserSessionId);
    assert.equal((projected.receipts[0].detail as any).actual, 'uuid-receipt');
    assert.equal((projected.receipts[1].detail as any).expected, 'uuid-receipt');
    assert.deepEqual(projected.checks[0].receiptIds, ['_r1', 'r1']);
    assert.deepEqual({ receipts, checks }, original);
});

function judgmentSpec(): SpecPair {
    return {
        commitSha: 'spec-sha', specBranch: 'spec/feature', specPrUrl: 'https://example.com/spec',
        product: { slug: 'feature', title: 'Archive tasks', problem: 'Completed tasks accumulate',
            goals: ['Keep active work visible'], nonGoals: ['Do not delete archived records'],
            stories: [{ id: 'US-1', title: 'Archive', asA: 'user', iWant: 'archive completed tasks', soThat: 'active work is visible',
                checks: ['Repeated narrative check'] }], acceptanceCriteria: ['Archive preserves records', 'Active tasks remain visible'],
            openQuestions: [], body: 'Repeated specification narrative'.repeat(1000) },
        tech: { slug: 'feature', approach: '', affectedAreas: [], dataModel: '', apiChanges: [], migrationPlan: '',
            validationPlan: [], alternatives: [], openQuestions: [], body: '' },
    };
}

test('decision packet retains every AC, human constraint, assertion and failure without copying narrative history', () => {
    const ctx = { issue: { ...fixtureIssue(), comments: [
        { author: 'operator', body: 'Preserve archived records', createdAt: '2026-10-06T00:00:00Z' },
        { author: 'operator', body: '<!-- factory-state:v1: --> internal progress', createdAt: '2026-10-06T00:00:01Z' },
    ] }, runId: 'new-judgment-stage' } as AgentContext;
    const checks: VerificationCheck[] = [{ criterion: 'Archive completed tasks', requirementIds: ['AC-1', 'UNKNOWN-AC'],
        passed: true, receiptIds: ['assertion', 'missing'] }];
    const generation = executedOutcome('verified', 'browser', 'Executor claims success', checks);
    generation.result.coverage = { specCommitSha: 'spec-sha', implementationSha: 'impl-sha', requirementsHash: 'hash',
        runId: 'original-execution', passingReceiptIds: ['assertion'] };
    const receipts = [
        { id: 'unrelated', kind: 'browser-action', passed: true, detail: { action: 'open', browserSessionId: 'other', url: '/unrelated' } },
        { id: 'navigation', kind: 'browser-action', passed: true, detail: { action: 'open', browserSessionId: 'current', url: '/tasks' } },
        { id: 'assertion', kind: 'browser-assertion', passed: true,
            detail: { actual: 'Archived', expected: 'Archived', browserSessionId: 'current', previousReceiptId: 'navigation' } },
        { id: 'counterevidence', kind: 'browser-assertion', passed: false,
            detail: { actual: 'Deleted', expected: 'Preserved', browserSessionId: 'current', previousReceiptId: 'assertion' } },
        { id: 'operator', kind: 'operator-test', passed: true, detail: { command: 'project regression', exitCode: 0 } },
        { id: 'startup-error', kind: 'service-action', passed: false, detail: { error: 'SERVICE_READY_TIMEOUT' } },
    ];
    const spec = judgmentSpec();
    const original = structuredClone({ ctx, generation, receipts, spec });
    const state = buildVerificationJudgmentState(ctx, 'verify', generation, receipts, { spec, implementationSha: 'impl-sha' });
    assert.equal(state.decision.runId, 'original-execution');
    assert.equal(state.decision.specCommitSha, 'spec-sha');
    assert.equal(state.decision.implementationSha, 'impl-sha');
    assert.deepEqual(state.requirements.map(({ id, criterion }) => ({ id, criterion })), [
        { id: 'AC-1', criterion: 'Archive preserves records' }, { id: 'AC-2', criterion: 'Active tasks remain visible' },
    ]);
    assert.deepEqual(state.requirements.map(requirement => requirement.checkIndexes), [[0], []]);
    assert.deepEqual(state.gaps.uncoveredRequirementIds, ['AC-2']);
    assert.deepEqual(state.gaps.unknownRequirementIds, ['UNKNOWN-AC']);
    assert.deepEqual(state.gaps.unknownReceiptIds, ['missing']);
    assert.equal(state.gaps.uncitedOperatorReceiptIds.length, 1);
    assert.equal(state.gaps.omittedSuccessfulActionCount, 1);
    assert.equal(state.factory.lastReceiptRegistry.receipts.length, 5);
    assert.equal(state.factory.lastReceiptRegistry.receipts.filter(receipt => !receipt.passed).length, 2);
    assert.ok(JSON.stringify(state).includes('/tasks'));
    assert.ok(JSON.stringify(state).includes('Deleted'));
    assert.ok(JSON.stringify(state).includes('Do not delete archived records'));
    assert.ok(JSON.stringify(state).includes('Preserve archived records'));
    assert.ok(!JSON.stringify(state).includes('internal progress'));
    assert.ok(!JSON.stringify(state).includes('Repeated specification narrative'));
    assert.ok(!JSON.stringify(state).includes('Repeated narrative check'));
    assert.deepEqual({ ctx, generation, receipts, spec }, original);
});

test('dynamic questions use actual requirement links, assertion kinds and run mode without averaging', () => {
    const ctx = { issue: fixtureIssue(), runId: 'execution' } as AgentContext;
    const checks: VerificationCheck[] = [
        { criterion: 'Records remain', requirementIds: ['AC-1'], passed: true, receiptIds: ['browser'] },
        { criterion: 'Active tasks remain', requirementIds: ['AC-2'], passed: true, receiptIds: ['command'] },
        { criterion: 'Action alone', requirementIds: ['AC-1'], passed: true, receiptIds: ['action'] },
    ];
    const receipts = [
        { id: 'browser', kind: 'browser-assertion', passed: true, detail: { expected: 'saved', actual: 'saved' } },
        { id: 'command', kind: 'test', passed: true, detail: { command: 'assert active work', exitCode: 0 } },
        { id: 'action', kind: 'browser-action', passed: true, detail: { action: 'click' } },
    ];
    const generation = executedOutcome('blocked', 'hybrid', 'Needs evidence', checks);
    const state = buildVerificationJudgmentState(ctx, 'verify', generation, receipts, { spec: judgmentSpec(), implementationSha: 'impl' });
    const request = buildTypesafeRequest(state, 'jev-latest');
    assert.deepEqual(Object.keys(request.questions), ['B9', 'B12', 'B11-0', 'B11-1', 'B11-2']);
    assert.match(JSON.stringify(request.questions.B9.instructions), /EVERY.*no averaging/);
    assert.match(JSON.stringify(request.questions['B11-0'].instructions), /requirements\[0\].*browserSessionId/);
    assert.doesNotMatch(JSON.stringify(request.questions['B11-0'].instructions), /cwd/);
    assert.match(JSON.stringify(request.questions['B11-1'].instructions), /requirements\[1\].*cwd/);
    assert.match(JSON.stringify(request.questions['B11-2'].instructions), /not acceptance assertions/);
    assert.ok(!JSON.stringify(request.questions).includes('"actual":"saved"'), 'Evidence is not duplicated inside questions');
    const reproductionState = buildVerificationJudgmentState(ctx, 'reproduce',
        executedOutcome('confirmed', 'hybrid', '', checks), receipts);
    const reproduction = buildTypesafeRequest(reproductionState, 'jev-latest');
    assert.deepEqual(Object.keys(reproduction.questions.B9.type === 'choice' ? reproduction.questions.B9.criteria : {}),
        ['confirmed', 'not-reproduced', 'blocked']);
    assert.equal(reproduction.questions.B12, undefined);
});

test('operator execution question cannot provide business coverage or weaken task-specific assertions', () => {
    const ctx = { issue: fixtureIssue(), runId: 'execution' } as AgentContext;
    const receipt = { id: 'operator', kind: 'operator-test', passed: true,
        detail: { command: 'node --version', exitCode: 0, stdout: 'v22.19.0' } };
    const checks = [operatorRegressionCheck(receipt), {
        criterion: 'Archive preserves records', requirementIds: ['AC-1'], passed: true, receiptIds: ['operator'],
    }];
    const state = buildVerificationJudgmentState(ctx, 'verify', executedOutcome('verified', 'desktop', '', checks),
        [receipt], { spec: judgmentSpec(), implementationSha: 'impl' });
    assert.deepEqual(state.requirements.map(requirement => requirement.checkIndexes), [[1], []]);
    assert.deepEqual(state.gaps.uncoveredRequirementIds, ['AC-2']);
    assert.deepEqual(state.gaps.uncitedOperatorReceiptIds, []);
    const request = buildTypesafeRequest(state, 'jev-latest');
    assert.match(JSON.stringify(request.questions['B11-0'].instructions), /exit code 0.*no AC links/);
    assert.match(JSON.stringify(request.questions['B11-1'].instructions), /requirements\[0\].*Exit zero alone is not the assertion/);
    assert.match(JSON.stringify(request.questions.B9.instructions), /EVERY authoritative requirement/);
});

test('decision packet exposes truncated observations and broken browser chains rather than inventing context', () => {
    const ctx = { issue: fixtureIssue(), runId: 'execution' } as AgentContext;
    const receipts = [
        { id: 'other-session', kind: 'browser-action', passed: true, detail: { browserSessionId: 'other' } },
        { id: 'cross-session', kind: 'browser-assertion', passed: true,
            detail: { browserSessionId: 'current', previousReceiptId: 'other-session', actual: 'x'.repeat(2100) } },
        { id: 'dangling', kind: 'browser-assertion', passed: false,
            detail: { browserSessionId: 'current', previousReceiptId: 'r0', expected: 'visible', actual: 'missing' } },
    ];
    const state = buildVerificationJudgmentState(ctx, 'verify', executedOutcome('blocked', 'browser', '', []), receipts);
    assert.equal(state.gaps.brokenBrowserChains.length, 2);
    assert.equal(state.gaps.truncatedReceiptIds.length, 1);
    assert.equal(state.factory.lastReceiptRegistry.receipts.length, 2);
    assert.ok(!state.factory.lastReceiptRegistry.receipts.some(receipt => receipt.id === 'r0'));
    assert.equal(state.factory.lastReceiptRegistry.receipts[1].passed, false);
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
    const project = path.join(workdir, 'project');
    mkdirSync(project, { recursive: true });
    return {
        repo: {
            owner: "acme",
            name: "factory",
            defaultBranch: "main",
            workdir: project,
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
        artifactStateDir: path.join(workdir, 'artifacts'),
    } as unknown as AgentContext;
}

async function receiptPathFor(ctx: AgentContext): Promise<string> {
    return path.join(await evidenceDirectory({ workdir: ctx.repo.workdir, stateDir: ctx.artifactStateDir,
        repository: `${ctx.repo.owner}/${ctx.repo.name}`, issueNumber: ctx.issue.number, runId: ctx.runId }), 'acceptance.json');
}

async function assertJudgmentBlocked(result: BehaviorVerificationResult, executed: GenerationOutcome, ctx: AgentContext,
    judgmentFailure: JudgmentFailure = { kind: 'contract', code: 'JUDGMENT_CONTRACT_INVALID' }) {
    assert.deepEqual(result, { ...executed.result, status: 'blocked',
        notes: `${executed.result.notes} Independent judgment incomplete or unavailable; execution receipts are retained, but semantic acceptance is not approved.`,
        executionCapabilities: VERIFICATION_CAPABILITY_HASH,
        receiptPath: await receiptPathFor(ctx), checks: executed.checks, judgmentFailure });
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

test("low-confidence B9 disagreement preserves evidence but cannot approve acceptance", async () => {
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
            assert.equal(result.status, "blocked", "uncertain disagreement cannot approve acceptance");
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

test("batch parse miss blocks acceptance and preserves executed receipts", async () => {
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
            await assertJudgmentBlocked(result, executed, ctx);
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

test("typesafe unavailable blocks acceptance without inventing failed product receipts", async () => {
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
            await assertJudgmentBlocked(result, executed, ctx, { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' });
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

test("FACTORY_TYPESAFE_OFF=1 skips fetch but cannot approve acceptance", async () => {
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
            await assertJudgmentBlocked(result, executed, ctx, { kind: 'configuration', code: 'JUDGMENT_CONFIGURATION_UNAVAILABLE' });
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
            const ctx = fixtureContext(workdir);
            ctx.runId = `run-all-ac-${last === undefined ? 'missing' : last >= 0.5 ? 'supported' : 'unsupported'}`;
            const result = await new VerifyBehaviorAgent(ctx, 'verify').run();
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
            await assertJudgmentBlocked(result, executed, ctx);
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
