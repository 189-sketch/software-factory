import { createHash } from 'node:crypto';
import { isFactoryComment } from './business-input.mjs';
import { PIPELINE_LABELS_TO_CLEAR } from './pipeline-definition.mjs';
import { hasSpecificationApproval } from './completion-contract.mjs';

// Version the review evidence/question protocol, never a build or an inference result.
const REVIEW_JUDGMENT_CONTRACT_VERSION = 1;

/** The evidence source is separate from the judgment applied to it. */
export function reviewGenerationEvidence(review) {
  const source = review.generatedReview ?? review;
  return structuredClone({ verdict: source.verdict, body: source.body,
    comments: source.comments ?? [], findings: source.findings ?? [] });
}

/** Keep verbatim diffs of cited files and an inventory of every other change. */
export function projectReviewDiff(diff, source) {
  const references = [...(source.findings ?? []).map(finding => finding.evidence?.path), ...(source.comments ?? []).map(comment => comment.path)]
    .filter(path => typeof path === 'string');
  const sections = (diff ?? '').split(/(?=^diff --git )/m).filter(section => section.trim());
  const narrative = [source.body, ...(source.findings ?? []).map(finding => finding.summary)].join('\n');
  const inventory = sections.map(section => {
    const paths = [...section.matchAll(/^(?:---|\+\+\+) (.+)$/gm)].map(match => {
      let path = match[1];
      if (path.startsWith('"')) { try { path = JSON.parse(path); } catch { return null; } }
      return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
    }).filter(Boolean);
    const included = paths.some(path => references.includes(path) || narrative.includes(path));
    return { header: section.split('\n', 1)[0], paths, included,
      bytes: Buffer.byteLength(section), sha256: createHash('sha256').update(section).digest('hex') };
  });
  return { prDiff: sections.filter((_, index) => inventory[index].included).join(''), changeInventory: inventory,
    missingReferencedPaths: [...new Set(references)].filter(path => !inventory.some(item => item.paths.includes(path))) };
}

/** Relevant observed inputs, not factory progress or invented repository facts. */
export function buildReviewPrJudgmentState(issue, review, context = {}, diff) {
  const source = reviewGenerationEvidence(review);
  const spec = context.specs;
  const { body: productBody, ...productFields } = spec?.product ?? {};
  const parsedProduct = Array.isArray(productFields.acceptanceCriteria) && productFields.acceptanceCriteria.length > 0;
  const { body: techBody, ...techFields } = spec?.tech ?? {};
  const parsedTech = Object.entries(techFields).some(([key, value]) => key !== 'slug'
    && (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0));
  return {
    decision: { stage: 'review-pr', headSha: context.headSha, baseSha: context.baseSha },
    scope: { purpose: 'Static implementation review against the current approved product and design, not runtime acceptance or merge permission',
      productSource: parsedProduct ? 'Current parsed PRODUCT.md fields; full prose is read by the generation reviewer, not independently audited in this judgment' : 'Current PRODUCT.md body; parsed acceptance criteria unavailable',
      codeSource: 'Verbatim diffs of files cited by generated findings or comments, plus the complete change inventory. Other code is read by the generation reviewer, not independently audited here. Missing referenced paths are explicit evidence gaps, not proof of absence.',
      technicalSource: parsedTech ? 'Current parsed TECH.md fields; full TECH.md prose is not included' : 'Current TECH.md body; parsed fields unavailable' },
    issue: { number: issue.number, title: issue.title, body: issue.body,
      labels: [...new Set((issue.labels ?? []).filter(label => !PIPELINE_LABELS_TO_CLEAR.includes(label)))].sort(),
      comments: (issue.comments ?? []).filter(comment => !isFactoryComment(comment))
        .map(comment => ({ author: comment.author, body: comment.body, createdAt: comment.createdAt })) },
    specification: { present: Boolean(spec), approved: context.approved ?? null, commitSha: spec?.commitSha,
      product: spec ? structuredClone(parsedProduct ? productFields : { ...productFields, body: productBody }) : null,
      technicalDesign: spec ? structuredClone(parsedTech ? techFields : { body: techBody }) : null },
    ...(diff === undefined ? {} : projectReviewDiff(diff, source)),
    reviewEvidence: { verdict: source.verdict, body: source.body, comments: source.comments,
      origin: review.generatedReview?.origin ?? 'provided-checkpoint-review' },
    reviewFindings: source.findings,
  };
}

/** Diff identity is bound by exact head/base SHAs; no inference result enters the input key. */
export function reviewJudgmentInputHash(issue, review, context) {
  return createHash('sha256').update(JSON.stringify({
    contractVersion: REVIEW_JUDGMENT_CONTRACT_VERSION,
    state: buildReviewPrJudgmentState(issue, review, context),
    sourceBodies: [context?.specs?.product?.body, context?.specs?.tech?.body],
    model: process.env.FACTORY_TYPESAFE_MODEL ?? 'jev-latest',
  })).digest('hex');
}

export function reviewJudgmentContextHash(state) {
  return reviewJudgmentInputHash(state.issue, state.review, { specs: state.specs,
    approved: hasSpecificationApproval(state), headSha: state.implementation?.commitSha, baseSha: state.reviewedBaseSha });
}

/** An actual changed evidence context admits one new review, never an approval or budget reset. */
export function needsReviewJudgmentContextRecovery(state) {
  return Boolean(state?.status === 'waiting' && !state.merged && state.issue?.state !== 'closed'
    && state.nextLabel === 'verified' && state.review?.verdict === 'APPROVE'
    && state.reviewedSha && state.reviewedBaseSha && state.reviewedSha === state.implementation?.commitSha
    && hasSpecificationApproval(state) && state.review.judgmentFailure?.kind !== 'configuration'
    && state.review.judgmentInputHash !== reviewJudgmentContextHash(state));
}
