import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentContext, FactoryIssueState } from '../core/types.js';

const exec = promisify(execFile);

export async function prepareReviewArtifacts(state: FactoryIssueState, repo: AgentContext['repo'], reviewDir: string) {
    const diffRange = `origin/${repo.defaultBranch}...${state.implementation!.commitSha}`;
    await writeReviewBundle(repo.workdir, reviewDir, {
      diffRange,
      diffFile: 'pr_diff.txt',
      descriptionFile: 'pr_description.txt',
      descriptionBody: state.implementation!.comment,
      emptyMessage: 'Review diff is empty',
    });
  }

/**
   * Stage the spec PR diff + PRODUCT.md / TECH.md bodies for the
   * ReviewSpecAgent. Mirrors `prepareReviewArtifacts` for the
   * implementation-review path.
   */
  export async function prepareSpecReviewArtifacts(state: FactoryIssueState, specCommitSha: string, specPrUrl: string, repo: AgentContext['repo'], reviewDir: string): Promise<void> {
    // Spec PRs are pure additions (PRODUCT.md + TECH.md only), so a
    // diff against the base SHA before this commit is exactly the spec
    // content. If the spec PR has touched other files in a future
    // expansion the diff still captures them.
    const baseSha = (await exec('git', ['rev-parse', `origin/${repo.defaultBranch}`], { cwd: repo.workdir })).stdout.trim();
    await writeReviewBundle(repo.workdir, reviewDir, {
      diffRange: `${baseSha}...${specCommitSha}`,
      diffFile: 'spec_diff.txt',
      descriptionFile: 'spec_description.txt',
      descriptionBody: `Spec PR for issue #${state.issue.number}\nURL: ${specPrUrl}\n`,
      extraFiles: [
        { file: 'spec_product.md', body: state.specs!.product.body },
        { file: 'spec_tech.md', body: state.specs!.tech.body },
      ],
      emptyMessage: 'Spec review diff is empty',
    });
  }

/**
   * Write the review artefact bundle (annotated diff + description +
   * optional extra files) for either an implementation PR or a spec
   * PR. Centralises the `git diff` invocation, the reviewDir mkdir,
   * and the empty-diff guard so both call sites stay in sync.
   */
  export async function writeReviewBundle(
    workdir: string,
    reviewDir: string,
    args: {
      diffRange: string;
      diffFile: string;
      descriptionFile: string;
      descriptionBody: string;
      extraFiles?: { file: string; body: string }[];
      emptyMessage: string;
    },
  ): Promise<void> {
    const patch = (await exec('git', ['diff', '--unified=3', args.diffRange], { cwd: workdir, maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (!patch.trim()) throw new Error(args.emptyMessage);
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(path.join(reviewDir, args.diffFile), annotateDiff(patch));
    await fs.writeFile(path.join(reviewDir, args.descriptionFile), args.descriptionBody);
    for (const extra of args.extraFiles ?? []) {
      await fs.writeFile(path.join(reviewDir, extra.file), extra.body);
    }
  }

export function annotateDiff(patch: string): string {
    const output: string[] = [];
    let oldLine: number | null = null;
    let newLine: number | null = null;
    for (const raw of patch.split("\n")) {
        const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            output.push(raw);
        } else if (raw.startsWith("--- ") || raw.startsWith("+++ ") || oldLine === null || newLine === null) {
            output.push(raw);
        } else if (raw.startsWith("-")) {
            output.push(`[OLD:${oldLine}] ${raw.slice(1)}`);
            oldLine += 1;
        } else if (raw.startsWith("+")) {
            output.push(`[NEW:${newLine}] ${raw.slice(1)}`);
            newLine += 1;
        } else if (raw.startsWith(" ")) {
            output.push(`[OLD:${oldLine},NEW:${newLine}] ${raw.slice(1)}`);
            oldLine += 1;
            newLine += 1;
        } else {
            output.push(raw);
        }
    }
    return output.join("\n");
}
