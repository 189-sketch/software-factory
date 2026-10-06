import type { Issue, ReviewResult, SpecPair, FactoryIssueState } from '../src/core/types.js';
export interface ReviewPrJudgmentContext {
  specs?: SpecPair;
  approved?: boolean;
  headSha?: string;
  baseSha?: string;
}
export function reviewGenerationEvidence(review: ReviewResult): Pick<ReviewResult, 'verdict' | 'body' | 'comments' | 'findings'>;
export function projectReviewDiff(diff: string, source: ReturnType<typeof reviewGenerationEvidence>): {
  prDiff: string; changeInventory: Array<{ header: string; paths: string[]; included: boolean; excerpted: boolean; bytes: number; sha256: string }>;
  missingReferencedLines: Array<{ path: string; line: number; endLine: number; side: 'LEFT' | 'RIGHT' }>;
  missingReferencedPaths: string[];
};
export function buildReviewPrJudgmentState(issue: Issue, review: ReviewResult, context?: ReviewPrJudgmentContext, diff?: string):
  Record<string, unknown> & { reviewFindings: NonNullable<ReviewResult['findings']>; prDiff?: string;
    changeInventory?: ReturnType<typeof projectReviewDiff>['changeInventory']; missingReferencedPaths?: string[];
    missingReferencedLines?: ReturnType<typeof projectReviewDiff>['missingReferencedLines'] };
export function reviewJudgmentInputHash(issue: Issue, review: ReviewResult, context?: ReviewPrJudgmentContext): string;
export function reviewJudgmentContextHash(state: FactoryIssueState): string;
export function needsReviewJudgmentContextRecovery(state: FactoryIssueState | null | undefined): boolean;
