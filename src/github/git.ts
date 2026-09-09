/**
 * Real Git/GitHub adapter.
 *
 * For a real GitHub repo, set GITHUB_TOKEN and the implementation agent will
 * use `gh` to push branches and open PRs. For local development, point the
 * target repo's `origin` at a bare remote (e.g. `/tmp/factory-remote.git`),
 * which this adapter treats as a GitHub stand-in: it pushes branches and
 * records the equivalent of a pull-request as a refs/pull/<n>/head ref.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

const runCommand: CommandRunner = async (command, args, options = {}) => {
  const result = await exec(command, args, options);
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
};

export interface CommitResult {
  branch: string;
  commitSha: string;
  ok: boolean;
  skipped?: boolean;
}

export interface PullRequestResult {
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseBranch: string;
  skipped?: boolean;
}

export interface MergeResult {
  merged: boolean;
  mergeCommitSha: string;
  mergedAt: string;
}

/**
 * Commit the working tree on a new branch and push to origin.
 * Returns the new branch name and commit SHA.
 */
export async function commitAndPush(opts: {
  workdir: string;
  branch: string;
  message: string;
  files?: string[];
}): Promise<CommitResult> {
  const { workdir, branch, message } = opts;
  // Only operate when workdir itself is the repository root. Git otherwise
  // walks into parent directories, which can mutate the factory source repo.
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: workdir });
    if (path.resolve(stdout.trim()) !== path.resolve(workdir)) {
      return { branch, commitSha: "", ok: false, skipped: true };
    }
  } catch {
    return { branch, commitSha: "", ok: false, skipped: true };
  }
  await exec("git", ["checkout", "-B", branch], { cwd: workdir });
  if (opts.files && opts.files.length > 0) {
    await exec("git", ["add", ...opts.files], { cwd: workdir });
  } else {
    // Atomic pathspec exclusion (git ≥ 2.13). factory/ is the runner's
    // private copy — it never belongs in a PR. The negative pathspec
    // is naturally idempotent whether or not factory/ exists.
    await exec("git", ["add", "-A", "--", ":!factory/"], { cwd: workdir });
    // Belt + suspenders: a defensive reset covers the rare race where
    // a stale index had factory/ staged before our pipeline ran (e.g.
    // a developer did `git add .` before the daemon picked up the
    // issue). Resetting is a no-op if factory/ isn't in the index.
    await exec("git", ["reset", "-q", "--", "factory/"], { cwd: workdir }).catch(() => {});
  }
  // Allow empty commits (e.g. when only a spec file changed and the impl agent
  // already committed earlier); otherwise commit changes. Git prints
  // "nothing to commit" / "nothing added to commit" on stdout (not stderr)
  // so we check both.
  try {
    await exec("git", ["commit", "-m", message], { cwd: workdir });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (!/nothing (?:to|added to) commit/i.test(combined)) throw err;
  }
  const { stdout: shaOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: workdir });
  const commitSha = shaOut.trim();
  await exec("git", ["push", "-u", "origin", branch], { cwd: workdir });
  return { branch, commitSha, ok: true };
}

/**
 * Open a "pull request" by creating refs/pull/<n>/head in the bare remote.
 *
 * In a real GitHub deployment the implementation agent would call
 * `gh pr create`. For local development against a bare remote we synthesize
 * the same shape: a numbered PR, a URL that points at the diff between the
 * feature branch and main, and the head SHA.
 */
export async function openPullRequest(opts: {
  workdir: string;
  remotePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}, run: CommandRunner = runCommand): Promise<PullRequestResult> {
  const { workdir, remotePath, branch, baseBranch, title, body } = opts;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: workdir });
    if (path.resolve(stdout.trim()) !== path.resolve(workdir)) throw new Error("workdir is not repository root");
  } catch {
    throw new Error("Cannot open a pull request outside the target repository root");
  }
  const origin = await readOrigin(workdir, remotePath, run);
  const githubRepo = parseGitHubRepo(origin) ?? parseGitHubRepo(remotePath);
  if (githubRepo) {
    return openGitHubPullRequest({ workdir, githubRepo, branch, baseBranch, title, body }, run);
  }
  const remoteName = "origin";
  // Fetch the head SHA from the remote.
  const { stdout: lsOut } = await run("git", ["ls-remote", remoteName, `refs/heads/${branch}`], { cwd: workdir });
  const headSha = lsOut.split(/\s+/)[0];
  if (!headSha) {
    throw new Error(`branch ${branch} not found on remote ${remoteName}`);
  }
  // Determine the next PR number.
  const { stdout: existingOut } = await run("git", ["ls-remote", remoteName], { cwd: workdir });
  const numbers = Array.from(existingOut.matchAll(/refs\/pull\/(\d+)\/head/g)).map((m) => Number(m[1]));
  const prNumber = (numbers.length ? Math.max(...numbers) : 100) + 1;
  // Write refs/pull/<n>/head to the bare remote.
  await run(
    "git",
    ["push", remoteName, `+${headSha}:refs/pull/${prNumber}/head`],
    { cwd: workdir },
  );
  // Also write PR metadata as a file so other steps can read it.
  await fs.mkdir(path.join(remotePath, "prs"), { recursive: true });
  await fs.writeFile(
    path.join(remotePath, "prs", `${prNumber}.json`),
    JSON.stringify({ number: prNumber, branch, baseBranch, title, body, headSha, createdAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  const prUrl = `file://${remotePath.replace(/\.git$/, "")}/pull/${prNumber}`;
  return { prNumber, prUrl, headSha, baseBranch };
}

async function readOrigin(workdir: string, fallback: string, run: CommandRunner): Promise<string> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd: workdir });
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
}

function parseGitHubRepo(remote: string): string | null {
  const match = remote.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function openGitHubPullRequest(
  opts: {
    workdir: string;
    githubRepo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  },
  run: CommandRunner,
): Promise<PullRequestResult> {
  const listArgs = [
    "pr", "list",
    "--repo", opts.githubRepo,
    "--head", opts.branch,
    "--base", opts.baseBranch,
    "--state", "open",
    "--json", "number,url,headRefOid,baseRefName",
    "--limit", "1",
  ];
  const existing = JSON.parse((await run("gh", listArgs, { cwd: opts.workdir })).stdout || "[]") as Array<{
    number: number;
    url: string;
    headRefOid: string;
    baseRefName: string;
  }>;
  let prUrl = existing[0]?.url;
  if (!prUrl) {
    const created = await run("gh", [
      "pr", "create",
      "--repo", opts.githubRepo,
      "--head", opts.branch,
      "--base", opts.baseBranch,
      "--title", opts.title,
      "--body", opts.body,
    ], { cwd: opts.workdir });
    prUrl = created.stdout.trim();
  }
  const viewed = JSON.parse((await run("gh", [
    "pr", "view", prUrl,
    "--repo", opts.githubRepo,
    "--json", "number,url,headRefOid,baseRefName",
  ], { cwd: opts.workdir })).stdout) as {
    number: number;
    url: string;
    headRefOid: string;
    baseRefName: string;
  };
  return {
    prNumber: viewed.number,
    prUrl: viewed.url,
    headSha: viewed.headRefOid,
    baseBranch: viewed.baseRefName,
  };
}

export async function mergePullRequest(opts: {
  workdir: string;
  remotePath: string;
  prUrl: string;
  expectedHeadSha?: string;
}, run: CommandRunner = runCommand): Promise<MergeResult> {
  const origin = await readOrigin(opts.workdir, opts.remotePath, run);
  const githubRepo = parseGitHubRepo(origin) ?? parseGitHubRepo(opts.remotePath);
  if (!githubRepo) {
    throw new Error("automatic merge currently requires a GitHub remote");
  }
  const readState = async () => JSON.parse((await run("gh", [
    "pr", "view", opts.prUrl,
    "--repo", githubRepo,
    "--json", "state,mergedAt,mergeCommit",
  ], { cwd: opts.workdir })).stdout) as {
    state: string;
    mergedAt: string | null;
    mergeCommit: { oid: string } | null;
  };
  let state = await readState();
  if (state.state !== "MERGED") {
    await run("gh", [
      "pr", "merge", opts.prUrl,
      "--repo", githubRepo,
      "--merge",
      ...(opts.expectedHeadSha ? ['--match-head-commit', opts.expectedHeadSha] : []),
      "--delete-branch",
    ], { cwd: opts.workdir });
    state = await readState();
  }
  if (state.state !== "MERGED" || !state.mergedAt || !state.mergeCommit?.oid) {
    throw new Error(`GitHub did not confirm PR merge; state=${state.state}`);
  }
  return {
    merged: true,
    mergeCommitSha: state.mergeCommit.oid,
    mergedAt: state.mergedAt,
  };
}
