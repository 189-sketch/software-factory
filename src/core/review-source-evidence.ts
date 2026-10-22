import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectReviewDiff, type ReviewPrJudgmentContext, type ReviewSourceEvidence,
  type reviewGenerationEvidence } from '../../runtime/review-judgment-context.mjs';

const exec = promisify(execFile);

/** Read cited repository code from immutable PR revisions, never from a dirty worktree. */
export async function collectReviewSourceEvidence(workdir: string, diff: string,
  source: ReturnType<typeof reviewGenerationEvidence>, context: ReviewPrJudgmentContext): Promise<ReviewSourceEvidence | undefined> {
  if (!context.headSha || !context.baseSha || ![context.headSha,context.baseSha].every(sha => /^[a-f0-9]{40,64}$/.test(sha))) return;
  const git = async (...args: string[]) => (await exec('git', args, {cwd:workdir,encoding:'utf8',maxBuffer:16*1024*1024})).stdout;
  try {
    const headPaths = (await git('ls-tree','-r','-z','--name-only',context.headSha)).split('\0').filter(Boolean);
    const basePaths = (await git('ls-tree','-r','-z','--name-only',context.baseSha)).split('\0').filter(Boolean);
    const evidence: ReviewSourceEvidence = {paths:[...new Set([...headPaths,...basePaths])],sources:[]};
    const projection = projectReviewDiff(diff, source, evidence);
    const selected = new Map(projection.resolvedReferences.map(ref=>[`${ref.side ?? 'RIGHT'}:${ref.path}`,ref]));
    for (const ref of selected.values()) {
      const side = ref.side ?? 'RIGHT';
      const revision = side === 'LEFT' ? context.baseSha : context.headSha;
      if (!(side === 'LEFT' ? basePaths : headPaths).includes(ref.path)) continue;
      evidence.sources.push({path:ref.path,side,revision,content:await git('show',`${revision}:${ref.path}`)});
    }
    return evidence;
  } catch (cause) {
    throw Object.assign(new Error('Cannot read review source from the pinned PR revisions', {cause}),
      {code:'FACTORY_AGENT_REVIEW_SOURCE_UNAVAILABLE'});
  }
}
