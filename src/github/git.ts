/**
 * Real Git/GitHub adapter.
 *
 * Git-level operations (commit, push, ls-remote) shell out to `git`.
 * GitHub API operations (PR list/open/view/merge, ref delete) go
 * through the undici REST client in `runtime/github-rest.mjs` — the
 * `gh` CLI is no longer used here: its GraphQL calls reliably lose
 * TLS on Windows after the daemon has been alive for a few minutes
 * (Phase B of the gh-instability fix, 2026-09-17).
 *
 * For local development, point the target repo's `origin` at a bare
 * remote (e.g. `/tmp/factory-remote.git`), which this adapter treats
 * as a GitHub stand-in: it pushes branches and records the equivalent
 * of a pull-request as a refs/pull/<n>/head ref.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as githubRest from "../../runtime/github-rest.mjs";

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

/**
 * Retry network-bound git commands on transient Windows TLS failures.
 *
 * Issue #29 (2026-09-17): `git push --force-with-lease` died with
 * `schannel: failed to receive handshake, SSL/TLS connection failed`
 * — the same long-lived-child TLS instability class that broke the
 * `gh` CLI (see runtime/github-rest.mjs header). A manual retry
 * seconds later succeeded, so these are transient; an unguarded push
 * turned one handshake blip into a failed stage and a supervisor
 * misroute. Patterns intentionally broad: any transport-layer failure
 * is worth 2 more tries; auth/permission/hook errors fail fast.
 */
const TRANSIENT_GIT_NETWORK_PATTERNS = /schannel|SSL\/TLS|TLS connection|failed to receive handshake|unable to access|Could not resolve|Connection (?:reset|refused|timed out)|timed? ?out|EOF|HTTP\/2|early EOF|RPC failed/i;

export async function runGitNetworkCommand(args: string[], opts: { cwd: string }, attempts = 3): Promise<{ stdout: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await exec("git", args, opts);
    } catch (err) {
      const e = err as { message?: string; stderr?: string; stdout?: string };
      const text = `${e.message ?? ""} ${e.stderr ?? ""} ${e.stdout ?? ""}`;
      if (attempt >= attempts || !TRANSIENT_GIT_NETWORK_PATTERNS.test(text)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

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
 * The GitHub REST surface this module uses. Injectable for tests;
 * production defaults to `runtime/github-rest.mjs` (undici client
 * with bounded retries and transient/permanent error classification).
 */
export interface PullRequestApi {
  listPullRequests(args: {
    token: string; repository: string; state?: string; head?: string; base?: string;
  }): Promise<Array<{ number: number; html_url: string }>>;
  openPullRequest(args: {
    token: string; repository: string; head: string; base: string; title: string; body: string;
  }): Promise<{ number: number; html_url: string }>;
  fetchPullRequest(args: {
    token: string; repository: string; number: number;
  }): Promise<RestPullRequest>;
  mergePullRequest(args: {
    token: string; repository: string; number: number; mergeMethod?: string; sha?: string;
  }): Promise<unknown>;
  deleteRef(args: { token: string; repository: string; ref: string }): Promise<boolean>;
  fetchGitCommit(args: { token: string; repository: string; sha: string }): Promise<githubRest.GitCommitRow>;
}

/** Raw REST shape of a pull request (subset the factory relies on). */
export interface RestPullRequest {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string | null } | null };
  base?: { ref?: string; sha?: string };
}

const defaultPullRequestApi = githubRest as unknown as PullRequestApi;

function requireGitHubToken(): string {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    throw new Error("GitHub token is required for pull-request operations (set GH_TOKEN or GITHUB_TOKEN)");
  }
  return token;
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
  /** Push with --force-with-lease (spec branches are re-cut from
   *  origin/main on every revision, so a REJECT revision legitimately
   *  rewrites the factory-owned branch). */
  force?: boolean;
  /** Persist the exact commit intent before the remote write. */
  beforePush?: (commitSha: string) => Promise<void>;
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
    // `-A` so deletions under a scoped pathspec are staged too — the
    // spec commit passes ["specs/"] and must carry the removal of a
    // superseded spec directory, not just additions (issue #29:
    // duplicate spec dirs survived a "delete" that was never staged).
    await exec("git", ["add", "-A", "--", ...opts.files], { cwd: workdir });
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
  await opts.beforePush?.(commitSha);
  const push = () => runGitNetworkCommand(["push", ...(opts.force ? ["--force-with-lease"] : []), "-u", "origin", branch], { cwd: workdir });
  try {
    await push();
  } catch (error) {
    // The lease compares against the remote-tracking ref. When the branch was
    // deleted remotely (merged PR with branch cleanup, re-cut spec branch) the
    // tracking ref is stale and git refuses with "stale info". Refresh the
    // tracking refs and retry once; the lease then guards the actual remote state.
    if (!opts.force || !/stale info/i.test(String((error as { stderr?: string }).stderr ?? (error as Error).message ?? error))) throw error;
    await runGitNetworkCommand(["fetch", "--prune", "origin"], { cwd: workdir });
    await push();
  }
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
}, run: CommandRunner = runCommand, api: PullRequestApi = defaultPullRequestApi): Promise<PullRequestResult> {
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
    return openGitHubPullRequest({ workdir, githubRepo, branch, baseBranch, title, body }, api);
  }
  const remoteName = "origin";
  // Simulated PR metadata lives beside the bare remote, never in the checkout.
  const remoteDir = remotePath || origin.replace(/^file:\/\//, "");
  if (!path.isAbsolute(remoteDir)) {
    throw new Error("Cannot open a local pull request without an absolute bare remote path");
  }
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
  await fs.mkdir(path.join(remoteDir, "prs"), { recursive: true });
  await fs.writeFile(
    path.join(remoteDir, "prs", `${prNumber}.json`),
    JSON.stringify({ number: prNumber, branch, baseBranch, title, body, headSha, createdAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  const prUrl = `file://${remoteDir.replace(/\.git$/, "")}/pull/${prNumber}`;
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
  api: PullRequestApi,
): Promise<PullRequestResult> {
  // Phase B (gh-instability fix): REST via undici instead of
  // `gh pr list/create/view` — the gh GraphQL calls drop TLS on
  // Windows minutes into a daemon's life.
  const token = requireGitHubToken();
  const [owner] = opts.githubRepo.split("/");
  const existing = await api.listPullRequests({
    token,
    repository: opts.githubRepo,
    state: "open",
    head: `${owner}:${opts.branch}`,
    base: opts.baseBranch,
  });
  let prNumber = existing[0]?.number;
  if (!prNumber) {
    const created = await api.openPullRequest({
      token,
      repository: opts.githubRepo,
      head: opts.branch,
      base: opts.baseBranch,
      title: opts.title,
      body: opts.body,
    });
    prNumber = created.number;
  }
  // Verify through a fresh fetch (mirrors the legacy `gh pr view`
  // round-trip): the head SHA the REST API reports is what downstream
  // contract checks compare against.
  const viewed = await api.fetchPullRequest({ token, repository: opts.githubRepo, number: prNumber });
  return {
    prNumber: viewed.number,
    prUrl: viewed.html_url,
    headSha: viewed.head?.sha ?? "",
    baseBranch: viewed.base?.ref ?? opts.baseBranch,
  };
}

export interface MergeCandidate { baseSha: string; headSha: string; treeSha: string }

export class MergeCandidateMismatchError extends Error {
  readonly code = 'FACTORY_MERGE_CANDIDATE_MISMATCH';
}

/**
 * The tree a merge of `head` into `base` would produce, or an error on
 * conflicts. Uses `git merge-tree --write-tree` (git >= 2.38) and falls
 * back to a throwaway detached worktree on older git, so merge-candidate
 * validation does not silently fail on hosts with an older git.
 */
export async function computeMergeTree(workdir: string, baseSha: string, headSha: string, run: CommandRunner = runCommand): Promise<string> {
  try {
    return (await run('git', ['merge-tree', '--write-tree', baseSha, headSha], { cwd: workdir })).stdout.trim().split(/\s+/)[0] ?? '';
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message ?? error);
    if (!/unknown rev --write-tree|unknown option|usage: git merge-tree/i.test(detail)) {
      throw new Error(`Merge of ${headSha} into ${baseSha} has conflicts`);
    }
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-merge-tree-'));
  try {
    await run('git', ['worktree', 'add', '--detach', scratch, baseSha], { cwd: workdir });
    try {
      await run('git', ['-c', 'user.name=factory', '-c', 'user.email=factory@localhost', 'merge', '--no-commit', '--no-ff', '--no-edit', headSha], { cwd: scratch });
    } catch {
      throw new Error(`Merge of ${headSha} into ${baseSha} has conflicts`);
    }
    return (await run('git', ['write-tree'], { cwd: scratch })).stdout.trim();
  } finally {
    await run('git', ['worktree', 'remove', '--force', scratch], { cwd: workdir }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Only transfer head validation when the exact prospective merge has the same tree. */
export async function prepareMergeCandidate(opts: {
  workdir: string; baseSha: string; headSha: string;
}, run: CommandRunner = runCommand): Promise<MergeCandidate> {
  for (const sha of [opts.baseSha, opts.headSha]) {
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Merge candidate requires exact commit SHAs');
  }
  const candidate = await computeMergeTree(opts.workdir, opts.baseSha, opts.headSha, run);
  const headTree = (await run('git', ['rev-parse', `${opts.headSha}^{tree}`], { cwd: opts.workdir })).stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(candidate) || candidate !== headTree) {
    throw new Error('Merge candidate differs from the verified head; integrate the current base and rerun review and verification');
  }
  return { baseSha: opts.baseSha, headSha: opts.headSha, treeSha: candidate };
}

export async function mergePullRequest(opts: {
  workdir: string;
  remotePath: string;
  prUrl: string;
  expectedHeadSha?: string;
  candidate?: MergeCandidate;
  expectedBaseBranch?: string;
}, run: CommandRunner = runCommand, api: PullRequestApi = defaultPullRequestApi): Promise<MergeResult> {
  const origin = await readOrigin(opts.workdir, opts.remotePath, run);
  const githubRepo = parseGitHubRepo(origin) ?? parseGitHubRepo(opts.remotePath);
  if (!githubRepo) {
    const remoteDir = opts.remotePath || origin.replace(/^file:\/\//, "");
    if (!remoteDir || !path.isAbsolute(remoteDir)) {
      throw new Error("automatic merge requires a GitHub remote or a local bare remote path");
    }
    return mergeLocalPullRequest({ ...opts, remoteDir }, run);
  }
  // Phase B (gh-instability fix): REST via undici instead of
  // `gh pr view/merge`. `sha` reproduces `--match-head-commit`
  // (GitHub 409s when the head moved); the head-ref delete
  // reproduces `--delete-branch`.
  const token = requireGitHubToken();
  const prNumber = parsePullNumber(opts.prUrl);
  const readState = () => api.fetchPullRequest({ token, repository: githubRepo, number: prNumber });
  let state = await readState();
  if (!state.merged) {
    if (opts.candidate && (state.html_url !== opts.prUrl || state.head?.sha !== opts.candidate.headSha
      || opts.expectedHeadSha !== opts.candidate.headSha || state.base?.sha !== opts.candidate.baseSha
      || !opts.expectedBaseBranch || state.base?.ref !== opts.expectedBaseBranch)) {
      throw new MergeCandidateMismatchError('Remote PR head or base changed after candidate validation; merge was not submitted');
    }
    await api.mergePullRequest({
      token,
      repository: githubRepo,
      number: prNumber,
      mergeMethod: "merge",
      ...(opts.expectedHeadSha ? { sha: opts.expectedHeadSha } : {}),
    });
    state = await readState();
  }
  if (!state.merged || !state.merged_at || !state.merge_commit_sha) {
    throw new Error(`GitHub did not confirm PR merge; state=${state.state}`);
  }
  if (opts.candidate) {
    const commit = await api.fetchGitCommit({ token, repository: githubRepo, sha: state.merge_commit_sha });
    if (state.head?.sha !== opts.candidate.headSha || state.base?.ref !== opts.expectedBaseBranch || commit.sha !== state.merge_commit_sha
      || commit.tree?.sha !== opts.candidate.treeSha || commit.parents?.length !== 2
      || commit.parents[0]?.sha !== opts.candidate.baseSha || commit.parents[1]?.sha !== opts.candidate.headSha) {
      throw new MergeCandidateMismatchError('Actual merge commit does not match the validated candidate; retain branch and do not confirm completion');
    }
  }
  const headRef = state.head?.ref;
  const headRepo = state.head?.repo?.full_name;
  if (headRef && (!headRepo || headRepo.toLowerCase() === githubRepo.toLowerCase())) {
    await api.deleteRef({ token, repository: githubRepo, ref: `heads/${headRef}` }).catch(() => {});
  }
  return {
    merged: true,
    mergeCommitSha: state.merge_commit_sha,
    mergedAt: state.merged_at,
  };
}

/**
 * Merge a pull request simulated by `openPullRequest` on a local bare
 * remote (offline fixture mode). Mirrors the GitHub path's guarantees:
 * the head must still be the expected commit, the merge commit must
 * carry the validated candidate tree with [base, head] parents, the base
 * branch only moves by fast-forward, and a retry after a lost response
 * returns the recorded merge instead of merging twice. The caller's
 * checkout is never touched; the merge commit is built with plumbing.
 */
async function mergeLocalPullRequest(opts: {
  workdir: string; remoteDir: string; prUrl: string; expectedHeadSha?: string;
  candidate?: MergeCandidate; expectedBaseBranch?: string;
}, run: CommandRunner): Promise<MergeResult> {
  const prNumber = parsePullNumber(opts.prUrl);
  const metadataFile = path.join(opts.remoteDir, "prs", `${prNumber}.json`);
  const metadata = JSON.parse(await fs.readFile(metadataFile, "utf-8")) as {
    branch: string; baseBranch: string; headSha: string; mergeCommitSha?: string; mergedAt?: string;
  };
  if (metadata.mergeCommitSha && metadata.mergedAt) {
    return { merged: true, mergeCommitSha: metadata.mergeCommitSha, mergedAt: metadata.mergedAt };
  }
  const baseBranch = metadata.baseBranch;
  if (opts.expectedBaseBranch && opts.expectedBaseBranch !== baseBranch) {
    throw new MergeCandidateMismatchError("Pull request base branch differs from the validated candidate; merge was not submitted");
  }
  const remoteHead = async (ref: string) => (await run("git", ["ls-remote", "origin", ref], { cwd: opts.workdir })).stdout.split(/\s+/)[0] ?? "";
  const headSha = (await remoteHead(`refs/pull/${prNumber}/head`)) || metadata.headSha;
  if (opts.expectedHeadSha && headSha !== opts.expectedHeadSha) {
    throw new MergeCandidateMismatchError("Pull request head moved after validation; merge was not submitted");
  }
  await run("git", ["fetch", "origin", `refs/heads/${baseBranch}`, `refs/pull/${prNumber}/head`], { cwd: opts.workdir });
  const baseSha = await remoteHead(`refs/heads/${baseBranch}`);
  if (!baseSha) throw new Error(`base branch ${baseBranch} not found on the local remote`);
  if (opts.candidate && (opts.candidate.headSha !== headSha || opts.candidate.baseSha !== baseSha)) {
    throw new MergeCandidateMismatchError("Remote PR head or base changed after candidate validation; merge was not submitted");
  }
  const treeSha = await computeMergeTree(opts.workdir, baseSha, headSha, run);
  if (opts.candidate && treeSha !== opts.candidate.treeSha) {
    throw new MergeCandidateMismatchError("Merge tree does not match the validated candidate; merge was not submitted");
  }
  const message = `Merge pull request #${prNumber} from ${metadata.branch}`;
  const mergeCommitSha = (await run("git", ["commit-tree", treeSha, "-p", baseSha, "-p", headSha, "-m", message], { cwd: opts.workdir })).stdout.trim();
  // Non-forced push: rejected if the base moved, never rewrites history.
  await run("git", ["push", "origin", `${mergeCommitSha}:refs/heads/${baseBranch}`], { cwd: opts.workdir });
  const mergedAt = new Date().toISOString();
  await fs.writeFile(metadataFile, JSON.stringify({ ...metadata, mergeCommitSha, mergedAt }, null, 2), "utf-8");
  await run("git", ["push", "origin", "--delete", metadata.branch], { cwd: opts.workdir }).catch(() => {});
  return { merged: true, mergeCommitSha, mergedAt };
}

function parsePullNumber(prUrl: string): number {
  const match = String(prUrl).match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse pull-request number from URL: ${prUrl}`);
  return Number(match[1]);
}
