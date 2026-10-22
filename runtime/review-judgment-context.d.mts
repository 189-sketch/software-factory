import type { Issue, ReviewResult, SpecPair, FactoryIssueState } from '../src/core/types.js';
export interface ReviewPrJudgmentContext {
  specs?: SpecPair;
  approved?: boolean;
  headSha?: string;
  baseSha?: string;
  sourceEvidence?: ReviewSourceEvidence;
}
export interface ReviewSourceEvidence {
  paths: string[];
  sources: Array<{path: string; side: 'LEFT' | 'RIGHT'; revision: string; content: string}>;
}
export const REVIEW_JUDGMENT_CONTRACT_VERSION: number;
export function reviewGenerationEvidence(review: ReviewResult): Pick<ReviewResult, 'verdict' | 'body' | 'comments' | 'findings' | 'references'>;
export function projectReviewDiff(diff: string, source: ReturnType<typeof reviewGenerationEvidence>, evidence?: ReviewSourceEvidence): {
  prDiff: string; changeInventory: Array<{ header: string; paths: string[]; included: boolean; excerpted: boolean; bytes: number; sha256: string }>;
  sourceExcerpts: Array<{path:string;side:'LEFT'|'RIGHT';revision:string;sourceSha256:string;startLine:number;endLine:number;content:string}>;
  missingReferencedLines: Array<{ path: string; line: number; endLine: number; side: 'LEFT' | 'RIGHT' }>;
  missingReferencedPaths: string[];
  resolvedReferences: Array<{ reference: string; path: string; line?: number; endLine?: number; side?: 'LEFT' | 'RIGHT' }>;
  ambiguousReferencedPaths: Array<{ path: string; candidates: string[] }>;
};
export function buildReviewPrJudgmentState(issue: Issue, review: ReviewResult, context?: ReviewPrJudgmentContext, diff?: string):
  Record<string, unknown> & { reviewFindings: NonNullable<ReviewResult['findings']>; prDiff?: string;
    sourceExcerpts?: ReturnType<typeof projectReviewDiff>['sourceExcerpts'];
    changeInventory?: ReturnType<typeof projectReviewDiff>['changeInventory']; missingReferencedPaths?: string[];
    missingReferencedLines?: ReturnType<typeof projectReviewDiff>['missingReferencedLines'];
    resolvedReferences?: ReturnType<typeof projectReviewDiff>['resolvedReferences'];
    ambiguousReferencedPaths?: ReturnType<typeof projectReviewDiff>['ambiguousReferencedPaths'] };
export function reviewJudgmentInputHash(issue: Issue, review: ReviewResult, context?: ReviewPrJudgmentContext): string;
export function reviewJudgmentContextHash(state: FactoryIssueState): string;
export function needsReviewJudgmentContextRecovery(state: FactoryIssueState | null | undefined): boolean;
