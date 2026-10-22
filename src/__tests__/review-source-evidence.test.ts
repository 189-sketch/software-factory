import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectReviewSourceEvidence } from '../core/review-source-evidence.js';
import { projectReviewDiff } from '../../runtime/review-judgment-context.mjs';
import { parseReviewResult, validateReviewEvidenceTool } from '../agents/review-pr.js';

test('active structured citations do not reactivate retired coordinates in correction prose', () => {
  const diff = 'diff --git a/card.ts b/card.ts\n--- a/card.ts\n+++ b/card.ts\n@@ -1 +1 @@\n-old()\n+new()\n';
  const source = parseReviewResult(JSON.stringify({ verdict: 'APPROVE', comments: [],
    body: 'Found: 0 critical, 0 important, 0 suggestions, 0 nits. Corrected `card.ts:60` to `card.ts:1`; bare TECH.md was ambiguous.',
    references: [{ path: 'card.ts', line: 1, side: 'RIGHT' }] }));
  const evidence = { paths: ['a/TECH.md', 'b/TECH.md'], sources: [] };
  const projected = projectReviewDiff(diff, source, evidence);
  assert.deepEqual(projected.missingReferencedLines, []);
  assert.deepEqual(projected.ambiguousReferencedPaths, []);
  assert.equal(projected.prDiff, diff);
  assert.equal(projectReviewDiff(diff, { ...source, references: [] }, evidence).prDiff, '',
    'Prose alone cannot ground an explicit empty reference list');
  assert.equal(projectReviewDiff(diff, { ...source, references: [{ path: 'card.ts', line: 60, side: 'RIGHT' }] }, evidence)
    .missingReferencedLines[0]!.line, 60, 'An active invalid coordinate remains an evidence gap');
  assert.throws(() => parseReviewResult(JSON.stringify({ ...source,
    references: [{ path: 'card.ts', line: 1, endLine: 0, side: 'RIGHT' }] })), /references must/);
});

test('review source collection grounds unchanged helpers and CI in pinned commits while preserving real gaps', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'factory-review-sources-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const exec = promisify(execFile);
  const git = async (...args:string[]) => (await exec('git',args,{cwd:root})).stdout;
  await git('init','-b','main');
  const original = Array.from({length:100},(_,i)=>`original line ${i+1}`).join('\n')+'\n';
  await fs.writeFile(path.join(root,'cli.js'),original);
  await fs.writeFile(path.join(root,'ci.yml'),'ubuntu and windows\n');
  await git('add','.');
  await git('-c','user.name=Test','-c','user.email=test@local','commit','-m','base');
  const baseSha = (await git('rev-parse','HEAD')).trim();
  await fs.writeFile(path.join(root,'cli.js'),original.replace('original line 80','changed line 80'));
  await git('add','.');
  await git('-c','user.name=Test','-c','user.email=test@local','commit','-m','head');
  const headSha = (await git('rev-parse','HEAD')).trim();
  const diff = await git('diff',baseSha,headSha);
  const source = {verdict:'APPROVE' as const,body:'`cli.js:3-5` uses the unchanged helper and `ci.yml:1` declares CI.',
    comments:[{path:'cli.js',line:80,side:'LEFT' as const,body:'Previous implementation'}],findings:[]};
  assert.equal(projectReviewDiff(diff,source).missingReferencedLines.length,1);
  assert.deepEqual(projectReviewDiff(diff,source).missingReferencedPaths,['ci.yml']);
  await fs.writeFile(path.join(root,'cli.js'),'DIRTY WORKTREE CONTENT');
  await fs.writeFile(path.join(root,'ci.yml'),'DIRTY CI');
  await fs.writeFile(path.join(root,'untracked.txt'),'untrusted');
  const evidence = await collectReviewSourceEvidence(root,diff,source,{headSha,baseSha});
  const projected = projectReviewDiff(diff,source,evidence);
  assert.deepEqual(projected.missingReferencedLines,[]);
  assert.deepEqual(projected.missingReferencedPaths,[]);
  assert.equal(projected.changeInventory.length,1,'Supplemental sources do not masquerade as changed files');
  assert.equal(projected.sourceExcerpts[0]!.content,'original line 3\noriginal line 4\noriginal line 5');
  assert.equal(projected.sourceExcerpts[0]!.revision,headSha);
  assert.ok(evidence!.sources.find(file=>file.side==='LEFT')!.content.includes('original line 80'));
  assert.ok(!evidence!.sources.find(file=>file.side==='LEFT')!.content.includes('changed line 80'));
  assert.ok(!JSON.stringify(projected).includes('DIRTY'));
  const invalid = {...source,body:'`cli.js:999` and `untracked.txt:1`'};
  const gaps = projectReviewDiff(diff,invalid,await collectReviewSourceEvidence(root,diff,invalid,{headSha,baseSha}));
  assert.equal(gaps.missingReferencedLines[0]!.line,999);
  assert.deepEqual(gaps.missingReferencedPaths,['untracked.txt']);
  const partial = {...source,body:'`cli.js:1-82`'};
  assert.equal(projectReviewDiff(diff,partial).missingReferencedLines.length,1,'A partial diff cannot establish an entire source range');
  assert.deepEqual(projectReviewDiff(diff,partial,evidence).missingReferencedLines,[]);
  const shorthand = {...source,body:'`cli.js:3-5` and `:77-81` use current code.\n`:999` has no path context.',comments:[]};
  const short = projectReviewDiff(diff,shorthand,await collectReviewSourceEvidence(root,diff,shorthand,{headSha,baseSha}));
  assert.ok(short.resolvedReferences.some(ref=>ref.path==='cli.js' && ref.line===77 && ref.endLine===81));
  assert.ok(!short.resolvedReferences.some(ref=>ref.line===999),'Never guess a shorthand path across lines');
  assert.deepEqual(short.missingReferencedLines,[]);
  const ctx = { repo: { workdir: root }, runId: 'review-preflight',
    issue: { number: 1, title: 'Review', body: 'Source evidence', labels: [], comments: [] } } as any;
  const validate = validateReviewEvidenceTool(ctx, diff, { headSha, baseSha });
  const draft = { ...source, comments: [], references: [{ path: 'cli.js', line: 999, side: 'RIGHT' }] };
  const invalidResult = await validate.execute({ reviewJson: JSON.stringify(draft) }, ctx) as any;
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.missingLines[0].line, 999);
  assert.deepEqual(invalidResult.sourceBounds, [{ path: 'cli.js', side: 'RIGHT', availableLines: 100 }]);
  draft.references[0]!.line = 80;
  const validResult = await validate.execute({ reviewJson: JSON.stringify(draft) }, ctx) as any;
  assert.equal(validResult.valid, true, 'A reviewer can repair the draft without launching another review run');
  assert.ok(validResult.codeBytes > 0);
  assert.equal(await fs.readFile(path.join(root, 'cli.js'), 'utf8'), 'DIRTY WORKTREE CONTENT', 'Read-only validation cannot repair product files');
});
