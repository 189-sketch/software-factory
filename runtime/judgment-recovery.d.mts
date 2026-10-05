import type { FactoryIssueState, IssueWait, JudgmentFailure } from '../src/core/types.js';
export function classifyJudgmentUnavailable(warnings: string[]): JudgmentFailure;
export function judgmentRecoveryContext(state: FactoryIssueState, stage: 'review' | 'verify'): string;
export function needsJudgmentRecovery(state: FactoryIssueState | null | undefined): boolean;
export function judgmentRetryPending(state: FactoryIssueState | null | undefined, now?: number): boolean;
export function judgmentResumeStage(state: FactoryIssueState | null | undefined, now?: number): 'review' | 'verify' | undefined;
export function scheduleJudgmentRetry(state: FactoryIssueState, stage: 'review' | 'verify', baseDelayMs: number, maxDelayMs: number, now?: number): IssueWait;
