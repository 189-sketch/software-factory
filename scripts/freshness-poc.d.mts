/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.4.
 *
 * TypeScript declaration shim for `scripts/freshness-poc.mjs` so the
 * unit test (`src/__tests__/freshness-poc.test.ts`) can import the
 * pure-JS module under `strict` typecheck. The JS module is the
 * single source of truth; this file mirrors its exports verbatim
 * and adds JSDoc-only types so the test can use the helpers
 * without `any`.
 */

/** Result of a `freshnessCheck(issue, options)` call. */
export interface FreshnessResult {
    skip: boolean;
    reason: string;
    stateHash: string;
    noul_yes: number;
}

/** Minimal `Issue` shape consumed by `buildJudgmentState` / `freshnessCheck`. */
export interface FreshnessIssueInput {
    number: number;
    state?: "open" | "closed";
    title?: string;
    body?: string;
    labels?: string[];
    updatedAt?: string;
    createdAt?: string;
    comments?: Array<{ author?: string; body?: string; createdAt?: string }>;
}

/** Factory-side inputs to `JudgmentState.factory`. */
export interface FreshnessFactoryContext {
    failureCounts?: Record<string, Record<string, number>>;
    priorDecisions?: ReadonlyArray<{ action: string; outcome: string; ts: string }>;
    lastReceiptRegistry?: Record<string, unknown>;
    lastTriageAt?: string;
}

/** Options bag for `buildJudgmentState` (subset used by freshness-poc). */
export interface BuildJudgmentStateOptions {
    issueUpdatedAt?: string;
    repoSignals?: { primaryLanguage?: string; hasOpenSpec?: boolean; hasOpenPRs?: number };
    isFactoryComment?: (comment: { body?: string }) => boolean;
    factory?: FreshnessFactoryContext;
}

/** JudgmentState shape (mirrors `src/core/judgment-state.ts::JudgmentState`). */
export interface FreshnessJudgmentState {
    issue: {
        number: number;
        state?: "open" | "closed";
        title: string;
        body: string;
        labels: string[];
        updatedAt: string;
        comments: Array<{ author: string; body: string; createdAt: string; isFactoryComment: boolean }>;
    };
    factory: {
        failureCounts: Record<string, Record<string, number>>;
        priorDecisions: ReadonlyArray<{ action: string; outcome: string; ts: string }>;
        lastTriageAt?: string;
        lastJudgmentHash?: string;
        lastReceiptRegistry?: Record<string, unknown>;
    };
    repoSignals: { primaryLanguage: string; hasOpenSpec: boolean; hasOpenPRs: number };
}

/** Options bag for `freshnessCheck`. */
export interface FreshnessCheckOptions {
    /** Authoritative GitHub recovery snapshot; polling must not persist it. */
    checkpoint?: { lastJudgmentHash?: string; lastTriageAt?: string; failureCounts?: Record<string, Record<string, number>> } | null;
    stateDir?: string | null;
    threshold?: number;
    env?: NodeJS.ProcessEnv;
    agentConfig?: { backends?: { typesafe?: { model?: string } }; timeoutMs?: number };
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    /** Deprecated compatibility option: polling no longer persists state. */
    persist?: boolean;
    now?: () => Date;
}

/** Freshness stats returned by `summariseFreshness`. */
export interface FreshnessStats {
    checked: number;
    skipped: number;
    fresh: number;
    unavailable: number;
    skippedRate: number;
}

export function buildJudgmentState(
    issue: FreshnessIssueInput,
    ctx?: { factory?: FreshnessFactoryContext } | undefined,
    opts?: BuildJudgmentStateOptions,
): FreshnessJudgmentState;

export function stateHashFor(state: FreshnessJudgmentState): string;

export function freshnessCheck(
    issue: FreshnessIssueInput,
    options?: FreshnessCheckOptions,
): Promise<FreshnessResult>;

export function computeHealthJs(
    scores: { spec: number; impl: number; review: number; verify: number },
    weights?: { spec: number; impl: number; review: number; verify: number },
): number;

export function summariseFreshness(
    outcomes: Array<{ skipped?: boolean; unavailable?: boolean }>,
): FreshnessStats;

export const DEFAULT_FRESHNESS_STATS: FreshnessStats;
