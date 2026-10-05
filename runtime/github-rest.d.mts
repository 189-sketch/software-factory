/**
 * Type declarations for `runtime/github-rest.mjs`. Mirrors the runtime
 * exports so TypeScript callers can `import { ... } from
 * "../../runtime/github-rest.mjs"` and get full inference.
 */

export function closeSharedAgent(): void;
export function _test_getWithRetry(
  url: string,
  opts?: { method?: string; token?: string; maxRetries?: number; timeoutMs?: number; conditional?: boolean },
): Promise<unknown>;

export interface IssueLabel { name: string; }

export interface IssueRow {
  number: number;
  title?: string;
  body?: string;
  labels?: IssueLabel[];
  author?: { login: string };
  createdAt?: string;
  updatedAt?: string;
  state?: string;
  url?: string;
  comments?: IssueComment[];
  /** REST /issues list only: number of comments (bodies need a per-issue fetch). */
  commentCount?: number;
}

export interface IssueComment {
  id?: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

export interface LabelCreate {
  name: string;
  color: string;
  description?: string;
}

export interface OpenPullRequestInput {
  token: string;
  repository: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestRow {
  number: number;
  html_url?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string | null } | null };
  base?: { ref?: string };
  headSha?: string;
  mergeable?: boolean;
}

export interface MergePullRequestInput {
  token: string;
  repository: string;
  number: number;
  commitMessage?: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  /** Pins the expected head SHA; GitHub 409s when the head moved. */
  sha?: string;
}

export function listOpenIssues(opts?: {
  token?: string;
  repository?: string;
  fields?: string[];
  perPage?: number;
  maxPages?: number;
}): Promise<IssueRow[]>;

export function setGitHubFetchImplForTest(implementation: typeof fetch | null): void;
export function closeIssue(opts: { token: string; repository: string; number: number }): Promise<unknown>;

export function fetchIssue(opts: {
  token: string;
  repository: string;
  number: number;
}): Promise<IssueRow>;

export function listIssues(opts: {
  token: string; repository: string; state?: "open" | "closed" | "all";
  labels?: string;
  fields?: string[]; perPage?: number; maxPages?: number;
}): Promise<IssueRow[]>;

export function listLeaseRefs(opts: { token: string; repository: string }): Promise<{ issueNumber: number; ref: string; sha: string }[]>;

export function listIssueComments(opts: {
  token: string;
  repository: string;
  number: number;
  perPage?: number;
}): Promise<IssueComment[]>;

export function upsertLabel(opts: {
  token: string;
  repository: string;
  name: string;
  color: string;
  description?: string;
}): Promise<unknown>;

export function setIssueLabels(opts: {
  token: string;
  repository: string;
  number: number;
  labels: string[];
}): Promise<unknown>;

export function syncIssueLabels(opts: {
  token: string;
  repository: string;
  number: number;
  current: string[];
  add?: string[];
  remove?: string[];
}): Promise<string[]>;

export function createIssueComment(opts: {
  token: string;
  repository: string;
  number: number;
  body: string;
  maxRetries?: number;
}): Promise<number | null>;

export function fetchAuthenticatedUser(opts: { token: string }): Promise<{ login: string }>;

export function getRef(opts: {
  token: string;
  repository: string;
  ref: string;
}): Promise<string | null>;

export function createRef(opts: {
  token: string;
  repository: string;
  ref: string;
  sha: string;
}): Promise<unknown>;

export function deleteRef(opts: {
  token: string;
  repository: string;
  ref: string;
}): Promise<boolean>;

export function getBranchSha(opts: {
  token: string;
  repository: string;
  branch: string;
}): Promise<string | null>;

export function getCommitTree(opts: {
  token: string;
  repository: string;
  sha: string;
}): Promise<string | null>;

export function createCommit(opts: {
  token: string;
  repository: string;
  message: string;
  tree: string;
  parents: string[];
}): Promise<{ sha?: string }>;

export function getCommitMessage(opts: {
  token: string;
  repository: string;
  sha: string;
}): Promise<string | null>;

export function listPullRequests(opts: {
  token: string;
  repository: string;
  state?: string;
  head?: string;
  base?: string;
  perPage?: number;
}): Promise<PullRequestRow[]>;

export function openPullRequest(opts: OpenPullRequestInput): Promise<PullRequestRow>;

export function fetchPullRequest(opts: {
  token: string;
  repository: string;
  number: number;
}): Promise<PullRequestRow>;

export function mergePullRequest(opts: MergePullRequestInput): Promise<unknown>;
