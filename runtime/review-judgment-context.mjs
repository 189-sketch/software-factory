import { createHash } from 'node:crypto';
import { isFactoryComment } from './business-input.mjs';
import { PIPELINE_LABELS_TO_CLEAR } from './pipeline-definition.mjs';
import { hasSpecificationApproval } from './completion-contract.mjs';

// Version the review evidence/question protocol, never a build or an inference result.
const REVIEW_JUDGMENT_CONTRACT_VERSION = 2;

/** The evidence source is separate from the judgment applied to it. */
export function reviewGenerationEvidence(review) {
  const source = review.generatedReview ?? review;
  return structuredClone({ verdict: source.verdict, body: source.body,
    comments: source.comments ?? [], findings: source.findings ?? [] });
}

/** Preserve cited source lines and declare gaps, never cut a file by character budget. */
function excerptCitedSection(section, paths, source, narrative) {
  const spans = paths.flatMap(path => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const textRefs = [...narrative.matchAll(new RegExp(`${escaped}:(\\d+)(?:-(\\d+))?`, 'g'))]
      .map(match => ({ path, line: Number(match[1]), endLine: Number(match[2] ?? match[1]), side: 'RIGHT' }));
    const structured = [...(source.findings ?? []).filter(f => f.evidence?.path === path).map(f => f.evidence),
      ...(source.comments ?? []).filter(comment => comment.path === path)]
      .filter(ref => Number.isSafeInteger(ref.line) && ref.line > 0)
      .map(ref => ({ path, line: ref.start_line ?? ref.line, endLine: ref.line,
        side: ref.side ?? (source.comments ?? []).find(comment => comment.path === path && comment.line === ref.line)?.side ?? 'RIGHT' }));
    return [...textRefs, ...structured].filter(ref => Number.isSafeInteger(ref.line) && ref.line > 0
      && Number.isSafeInteger(ref.endLine) && ref.endLine >= ref.line);
  });
  if (!spans.length) return { text: section, missing: [], excerpted: false };
  let oldLine = 0, newLine = 0, hunk = '', header = '';
  const rows = [];
  for (const raw of section.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); hunk = raw; continue; }
    if (!hunk) { header += raw; continue; }
    const sign = raw[0];
    if (![' ', '+', '-'].includes(sign)) continue;
    rows.push({ raw, hunk, oldLine: sign === '+' ? null : oldLine, newLine: sign === '-' ? null : newLine });
    if (sign !== '+') oldLine++;
    if (sign !== '-') newLine++;
  }
  const matches = (row, span) => {
    const line = span.side === 'LEFT' ? row.oldLine : row.newLine;
    return line !== null && line >= span.line && line <= span.endLine;
  };
  const missing = spans.filter(span => !rows.some(row => matches(row, span)));
  const anchors = rows.flatMap((row, index) => spans.some(span => matches(row, span)) ? [index] : []);
  // Neighboring diff rows retain adjacent deletion/replacement pairs, even when old/new line numbers diverge.
  const selected = rows.map((row, index) => ({ ...row, index })).filter(row => anchors.some(index => Math.abs(index - row.index) <= 3));
  if (selected.length === rows.length && rows.length) return { text: section, missing, excerpted: false };
  let text = header, previous = -1, previousHunk = '';
  for (const row of selected) {
    const newHunk = row.hunk !== previousHunk;
    const gap = row.index !== previous + 1;
    if (newHunk) { text += row.hunk; previousHunk = row.hunk; }
    if (gap) text += '[... omitted diff lines ...]\n';
    if (newHunk || gap) text += `[excerpt oldLine=${row.oldLine ?? '-'} newLine=${row.newLine ?? '-'}]\n`;
    text += row.raw;
    previous = row.index;
  }
  if (previous < rows.length - 1) text += '[... omitted diff lines ...]\n';
  return { text: selected.length ? text : '', missing, excerpted: true };
}

/** Keep cited evidence with exact diff identities and an inventory of every change. */
export function projectReviewDiff(diff, source) {
  const references = [...(source.findings ?? []).map(finding => finding.evidence?.path), ...(source.comments ?? []).map(comment => comment.path)]
    .filter(path => typeof path === 'string');
  const sections = (diff ?? '').split(/(?=^diff --git )/m).filter(section => section.trim());
  const narrative = [source.body, ...(source.findings ?? []).map(finding => finding.summary)].join('\n');
  const excerpts = [];
  const missingReferencedLines = [];
  const inventory = sections.map(section => {
    const paths = [...section.matchAll(/^(?:---|\+\+\+) (.+)$/gm)].map(match => {
      let path = match[1];
      if (path.startsWith('"')) { try { path = JSON.parse(path); } catch { return null; } }
      return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
    }).filter(Boolean);
    const included = paths.some(path => references.includes(path) || narrative.includes(path));
    const excerpt = included ? excerptCitedSection(section, paths, source, narrative) : null;
    excerpts.push(excerpt?.text ?? '');
    missingReferencedLines.push(...(excerpt?.missing ?? []));
    return { header: section.split('\n', 1)[0], paths, included, excerpted: excerpt?.excerpted ?? false,
      bytes: Buffer.byteLength(section), sha256: createHash('sha256').update(section).digest('hex') };
  });
  return { prDiff: excerpts.join(''), changeInventory: inventory, missingReferencedLines,
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
      codeSource: 'Source diff excerpts at cited lines/ranges with three neighboring diff rows, explicit coordinates/omission markers, and full file diffs only when no line references exist. Excerpts are not applicable patches. The complete change inventory binds full diff hashes. Missing referenced paths/lines are evidence gaps, not proof of absence. Omitted code is read by the generation reviewer, not independently audited here.',
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
  const unjudged = state?.nextLabel === 'review-needed' && state.wait?.reason === 'blocked-operator'
    && ['capacity', 'contract'].includes(state.review?.judgmentFailure?.kind);
  return Boolean(state?.status === 'waiting' && !state.merged && state.issue?.state !== 'closed'
    && (unjudged || (state.nextLabel === 'verified' && state.review?.verdict === 'APPROVE'))
    && state.reviewedSha && state.reviewedBaseSha && state.reviewedSha === state.implementation?.commitSha
    && hasSpecificationApproval(state) && state.review.judgmentFailure?.kind !== 'configuration'
    && state.review.judgmentInputHash !== reviewJudgmentContextHash(state));
}
