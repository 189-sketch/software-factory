import { createHash } from 'node:crypto';
import { isFactoryComment } from './business-input.mjs';
import { PIPELINE_LABELS_TO_CLEAR } from './pipeline-definition.mjs';
import { hasSpecificationApproval } from './completion-contract.mjs';

// Version the review evidence/question protocol, never a build or an inference result.
export const REVIEW_JUDGMENT_CONTRACT_VERSION = 12;

/** The evidence source is separate from the judgment applied to it. */
export function reviewGenerationEvidence(review) {
  const source = review.generatedReview ?? review;
  return structuredClone({ verdict: source.verdict, body: source.body,
    comments: source.comments ?? [], findings: source.findings ?? [],
    ...(source.references !== undefined ? { references: source.references } : {}) });
}

/** Preserve cited source lines and declare gaps, never cut a file by character budget. */
function excerptCitedSection(section, spans) {
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
  const missing = spans.filter(span => new Set(rows.filter(row => matches(row, span))
    .map(row => span.side === 'LEFT' ? row.oldLine : row.newLine)).size !== span.endLine - span.line + 1);
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
export function projectReviewDiff(diff, source, evidence = {}) {
  const sections = (diff ?? '').split(/(?=^diff --git )/m).filter(section => section.trim());
  // Legacy reports use prose; explicit citations never re-activate retired references in correction notes.
  const narrative = source.references === undefined
    ? [source.body, ...(source.findings ?? []).map(finding => finding.summary)].join('\n') : '';
  const sectionPaths = sections.map(section => {
    const paths = [...section.matchAll(/^(?:---|\+\+\+) (.+)$/gm)].map(match => {
      let path = match[1];
      if (path.startsWith('"')) { try { path = JSON.parse(path); } catch { return null; } }
      return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
    }).filter(Boolean);
    return [...new Set(paths)];
  });
  const allPaths = [...new Set([...sectionPaths.flat(), ...(evidence.paths ?? [])])];
  const references = [...(source.findings ?? []).map(f => f.evidence), ...(source.comments ?? []), ...(source.references ?? [])]
    .filter(ref => typeof ref?.path === 'string')
    .map(ref => ({ reference: ref.path, line: ref.start_line ?? ref.line, endLine: ref.endLine ?? ref.line,
      side: ref.side ?? (source.comments ?? []).find(c => c.path === ref.path && c.line === ref.line)?.side ?? 'RIGHT' }));
  // Parse coordinates before selection, including backtick-quoted paths containing spaces.
  for (const match of narrative.matchAll(/`([^`\r\n]+?):(\d+)(?:-(\d+))?`|(?<![\w./\\-])([\w./\\@+-]+\.[\w]+):(\d+)(?:-(\d+))?/g)) {
    const line = Number(match[2] ?? match[5]);
    references.push({ reference: match[1] ?? match[4], line, endLine: Number(match[3] ?? match[6] ?? line), side: 'RIGHT' });
  }
  // A shorthand coordinate is bound only to an explicit path earlier on the same line.
  for (const line of narrative.split('\n')) {
    let priorPath;
    for (const match of line.matchAll(/`([^`]+?):(\d+)(?:-(\d+))?`|(?<![\w./\\-])([\w./\\@+-]+\.[\w]+):(\d+)(?:-(\d+))?|`:(\d+)(?:-(\d+))?`/g)) {
      if (match[1] || match[4]) priorPath = match[1] ?? match[4];
      else if (priorPath) references.push({reference:priorPath,line:Number(match[7]),endLine:Number(match[8] ?? match[7]),side:'RIGHT'});
    }
  }
  // Preserve file-only mentions; resolve suffixes only when their identity is unique.
  const aliases = new Set(allPaths.flatMap(path => path.split('/').map((_, i, parts) => parts.slice(i).join('/'))));
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\w./\\\\-])${escaped}(?![\\w./\\\\-])`).test(narrative)
      && !references.some(ref => ref.reference === alias)) references.push({ reference: alias });
  }
  const resolvedReferences = [], missingReferencedPaths = [], ambiguousReferencedPaths = [];
  for (const ref of references) {
    const normalized = ref.reference.replace(/\\/g, '/').replace(/^\.\//, '');
    const candidates = allPaths.includes(normalized) ? [normalized] : allPaths.filter(path => path.endsWith(`/${normalized}`));
    if (candidates.length === 0) { missingReferencedPaths.push(ref.reference); continue; }
    if (candidates.length > 1) { ambiguousReferencedPaths.push({ path: ref.reference, candidates }); continue; }
    const resolved = { ...ref, path: candidates[0] };
    if (!resolvedReferences.some(prior => JSON.stringify(prior) === JSON.stringify(resolved))) resolvedReferences.push(resolved);
  }
  const excerpts = [], missingReferencedLines = [];
  const inventory = sections.map((section, index) => {
    const paths = sectionPaths[index];
    const refs = resolvedReferences.filter(ref => paths.includes(ref.path));
    const included = refs.length > 0;
    const spans = refs.filter(ref => Number.isSafeInteger(ref.line) && ref.line > 0
      && Number.isSafeInteger(ref.endLine) && ref.endLine >= ref.line).map(({ reference, ...span }) => span);
    const excerpt = included ? excerptCitedSection(section, spans) : null;
    excerpts.push(excerpt?.text ?? '');
    missingReferencedLines.push(...(excerpt?.missing ?? []));
    return { header: section.split('\n', 1)[0], paths, included, excerpted: excerpt?.excerpted ?? false,
      bytes: Buffer.byteLength(section), sha256: createHash('sha256').update(section).digest('hex') };
  });
  const sourceExcerpts = [];
  const unresolvedLines = [];
  for (const ref of resolvedReferences) {
    const outsideDiff = !sectionPaths.some(paths => paths.includes(ref.path));
    const missing = missingReferencedLines.some(span => span.path === ref.path && span.side === ref.side
      && span.line === ref.line && span.endLine === ref.endLine);
    if (!outsideDiff && !missing) continue;
    const file = evidence.sources?.find(file => file.path === ref.path && file.side === (ref.side ?? 'RIGHT'));
    if (!file) {
      if (missing) unresolvedLines.push(ref);
      else missingReferencedPaths.push(ref.path);
      continue;
    }
    const lines = file.content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const startLine = ref.line ?? 1, endLine = ref.endLine ?? lines.length;
    if (startLine < 1 || endLine > lines.length || endLine < startLine) {
      unresolvedLines.push(ref);
      continue;
    }
    sourceExcerpts.push({ path: ref.path, side: file.side, revision: file.revision,
      sourceSha256: createHash('sha256').update(file.content).digest('hex'), startLine, endLine,
      content: lines.slice(startLine - 1, endLine).join('\n') });
  }
  return { prDiff: excerpts.join(''), sourceExcerpts, changeInventory: inventory, missingReferencedLines: unresolvedLines
      .map(({path,line,endLine,side})=>({path,line,endLine,side})),
    missingReferencedPaths: [...new Set(missingReferencedPaths)], resolvedReferences,
    ambiguousReferencedPaths: [...new Map(ambiguousReferencedPaths.map(ref => [ref.path, ref])).values()] };
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
      codeSource: 'Source diff excerpts at cited lines/ranges with three neighboring diff rows, explicit coordinates/omission markers, and full file diffs only when no line references exist. sourceExcerpts supplement cited unchanged lines/files from immutable head (RIGHT) or base (LEFT) Git blobs, with revision, exact line range and full source hash. They are source code, not additional changed files. resolvedReferences maps uniquely resolved short citations to exact repository paths without changing the reviewer report. Ambiguous references are declared, never guessed. Excerpts are not applicable patches. The complete change inventory binds full diff hashes. Missing referenced paths/lines are evidence gaps, not proof of absence. Omitted code is read by the generation reviewer, not independently audited here.',
      technicalSource: parsedTech ? 'Current parsed TECH.md fields; full TECH.md prose is not included' : 'Current TECH.md body; parsed fields unavailable' },
    issue: { number: issue.number, title: issue.title, body: issue.body,
      labels: [...new Set((issue.labels ?? []).filter(label => !PIPELINE_LABELS_TO_CLEAR.includes(label)))].sort(),
      comments: (issue.comments ?? []).filter(comment => !isFactoryComment(comment))
        .map(comment => ({ author: comment.author, body: comment.body, createdAt: comment.createdAt })) },
    specification: { present: Boolean(spec), approved: context.approved ?? null, commitSha: spec?.commitSha,
      product: spec ? structuredClone(parsedProduct ? productFields : { ...productFields, body: productBody }) : null,
      technicalDesign: spec ? structuredClone(parsedTech ? techFields : { body: techBody }) : null },
    ...(diff === undefined ? {} : projectReviewDiff(diff, source, context.sourceEvidence)),
    reviewEvidence: { verdict: source.verdict, body: source.body, comments: source.comments, references: source.references,
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
  const restricted = state?.review?.judgmentFailure?.code === 'JUDGMENT_SERVICE_RESTRICTED'
    && state.review.judgmentFailure.kind === 'configuration';
  const unjudged = state?.nextLabel === 'review-needed' && state.wait?.reason === 'blocked-operator'
    && (restricted || ['capacity', 'contract'].includes(state.review?.judgmentFailure?.kind));
  return Boolean(state?.status === 'waiting' && !state.merged && state.issue?.state !== 'closed'
    && (unjudged || (state.nextLabel === 'verified' && state.review?.verdict === 'APPROVE'))
    && state.reviewedSha && state.reviewedBaseSha && state.reviewedSha === state.implementation?.commitSha
    && hasSpecificationApproval(state) && (restricted || state.review.judgmentFailure?.kind !== 'configuration')
    && (restricted || state.review.judgmentInputHash !== reviewJudgmentContextHash(state)));
}
