/**
 * Orchestrator side of failure-driven learning (see core/lessons.ts).
 *
 * Translates the pipeline's own quality gates into failure signals for
 * the agent whose work failed them:
 *
 * | Observation                                  | Agent that learns  |
 * | -------------------------------------------- | ------------------ |
 * | stage threw a validation / contract error    | the stage's agent  |
 * | spec review REJECT (final gate)              | spec               |
 * | code review REJECT                           | implementation     |
 * | review confirmed a technical spec defect     | spec               |
 * | verification proved a product defect         | implementation     |
 * | verification lacked evidence                 | verify-behavior    |
 *
 * Passing gates credit the lessons that were in front of the agent.
 */
import type { BehaviorVerificationResult, Finding, ReviewComment } from '../core/types.js';

const MAX_DETAIL = 7000;

function findingLines(findings: Finding[] | undefined): string[] {
  return (findings ?? []).filter(finding => finding.status === 'open')
    .map(finding => `- [${finding.severity}] ${finding.summary}${finding.evidence?.excerpt ? ` — ${finding.evidence.excerpt.slice(0, 300)}` : ''}`);
}

function commentLines(comments: ReviewComment[] | undefined): string[] {
  return (comments ?? []).map(comment => `- ${comment.path}:${comment.line} ${comment.body.slice(0, 400)}`);
}

export function reviewRejectionDetail(review: { body: string; comments?: ReviewComment[]; findings?: Finding[]; notes?: string }, subject: string): string {
  return [
    `${subject} was REJECTED by the independent reviewer.`,
    'Review body:', review.body.slice(0, 3000),
    ...(review.findings?.length ? ['Findings:', ...findingLines(review.findings)] : []),
    ...(review.comments?.length ? ['Inline comments:', ...commentLines(review.comments)] : []),
    ...(review.notes ? ['Reviewer notes:', review.notes.slice(0, 1000)] : []),
  ].join('\n').slice(0, MAX_DETAIL);
}

export function verificationFailureDetail(result: BehaviorVerificationResult): string {
  const failed = (result.checks ?? []).filter(check => !check.passed)
    .map(check => `- ${check.requirementIds?.join(', ') || 'unmapped'}: ${check.criterion}`);
  return [
    `Behavior verification returned ${result.status}${result.failure ? ` (owner: ${result.failure.kind})` : ''}.`,
    ...(result.failure?.reason ? ['Failure reason:', result.failure.reason.slice(0, 2500)] : []),
    ...(failed.length ? ['Failed checks:', ...failed] : []),
    'Verifier notes:', (result.notes ?? '').slice(0, 2500),
  ].join('\n').slice(0, MAX_DETAIL);
}
