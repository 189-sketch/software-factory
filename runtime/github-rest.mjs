/**
 * GitHub REST API client for the factory daemon — read AND write paths.
 *
 * Why this exists
 * ───────────────
 * The daemon shells out to `gh` for many operations. On Windows the
 * `gh` child process reliably loses its TLS session to api.github.com
 * after the daemon has been alive for several minutes (the user can
 * run `gh issue list` from their shell with no problem). The failure
 * mode is `net/http: TLS handshake timeout` or `Post ... EOF`.
 *
 * Phase A routes the polling list through undici + a persistent Agent.
 * Phase B routes the write path (label sync, comments, lease refs,
 * commit creation, PR open/merge) through the same client. After
 * Phase B the daemon never shells out to `gh` for any GitHub REST
 * API call — `gh` is reserved for git-level operations (`gh pr
 * create` is still CLI-bound, but `gh api` is no longer used).
 *
 * Trade-offs vs the gh CLI
 * ───────────────────────
 * - We lose gh's auto-auth (`gh auth status`): this module requires
 *   an explicit `token` parameter. The factory daemon reads
 *   `GH_TOKEN` (or `GITHUB_TOKEN`) and passes it through.
 * - Pagination: every paginated helper follows `per_page` + `page`
 *   until the response is short or `maxPages` is exhausted.
 * - All callers see transient vs permanent failures via the
 *   `transient` property on thrown errors. The daemon's existing
 *   retry envelopes (`runCommandWithRetry`) compose with this.
 *
 * Concurrency
 * ───────────
 * The Agent is module-scoped and shared across every fetch. The
 * fetch dispatcher is a singleton so the underlying connection
 * pool reuses sockets per host. `closeSharedAgent()` is the
 * call-site's escape hatch for tests that need to release sockets.
 */

import { Agent, fetch } from "undici";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
let fetchImpl = fetch;
export function setGitHubFetchImplForTest(implementation) {
  fetchImpl = implementation ?? fetch;
  conditionalResponses.clear(); conditionalBytes = 0;
  commentPageSizes.clear();
}

const USER_AGENT = "software-factory-cli";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_WRITE_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const CONDITIONAL_BUDGET_BYTES = 32 * 1024 * 1024;
const conditionalResponses = new Map();
const commentPageSizes = new Map();
let conditionalBytes = 0;

function forgetConditionalResponse(key) {
  const previous = conditionalResponses.get(key);
  if (previous) { conditionalBytes -= previous.bytes; conditionalResponses.delete(key); }
}

function rememberConditionalResponse(key, etag, text) {
  forgetConditionalResponse(key);
  // Retain lossless wire bytes, not UTF-16 history copies; the remote validator remains mandatory.
  const decodedBytes = Buffer.byteLength(text);
  const packed = deflateSync(Buffer.from(text));
  const bytes = packed.byteLength + 2 * (key.length + etag.length) + 512;
  if (bytes > CONDITIONAL_BUDGET_BYTES) return;
  while (conditionalBytes + bytes > CONDITIONAL_BUDGET_BYTES) forgetConditionalResponse(conditionalResponses.keys().next().value);
  conditionalResponses.set(key, { etag, packed, decodedBytes, bytes });
  conditionalBytes += bytes;
}

let sharedAgent = null;
function getAgent({ keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_MS } = {}) {
  if (sharedAgent) return sharedAgent;
  sharedAgent = new Agent({
    keepAliveTimeout: keepAliveTimeoutMs,
    keepAliveMaxTimeout: keepAliveTimeoutMs * 10,
    connect: { timeout: 5_000 },
    headersTimeout: DEFAULT_TIMEOUT_MS,
    bodyTimeout: DEFAULT_TIMEOUT_MS * 3,
    pipelining: 0, // GitHub doesn't need HTTP/2 pipelining for our use case
  });
  return sharedAgent;
}

/**
 * Test-only escape hatch: close all sockets the dispatcher is
 * holding. Production code does not call this.
 */
export function closeSharedAgent() {
  conditionalResponses.clear(); conditionalBytes = 0;
  commentPageSizes.clear();
  if (!sharedAgent) return;
  sharedAgent.close();
  sharedAgent = null;
}

function authHeaders(token) {
  if (!token) throw new Error("GitHub REST: token is required");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classify(err, status) {
  if (status !== undefined) {
    err.status = status;
    err.transient = RETRYABLE_STATUS.has(status);
  } else {
    err.transient = true;
  }
  return err;
}

/** Publish endpoint categories and timings, never URLs, headers, credentials or response bodies. */
function requestDiagnostic(url, method, phase, attempt, startedAt, timeoutMs, status) {
  const parsed = new URL(url);
  const resource = /\/issues\/\d+\/comments$/.test(parsed.pathname) ? 'issue-comments'
    : /\/issues\/\d+$/.test(parsed.pathname) ? 'issue'
    : /\/git\/refs?\//.test(parsed.pathname) ? 'git-ref'
    : parsed.pathname === '/user' ? 'writer' : 'github-api';
  const pagination = resource === 'issue-comments' ? Object.fromEntries(['page', 'per_page'].flatMap(key => {
    const value = Number(parsed.searchParams.get(key));
    return Number.isSafeInteger(value) && value > 0 ? [[key === 'per_page' ? 'perPage' : key, value]] : [];
  })) : {};
  return { resource, method, phase, attempt: attempt + 1, elapsedMs: Date.now() - startedAt, timeoutMs,
    ...(status === undefined ? {} : { status }), ...pagination };
}

/**
 * Single request with bounded retries on transient failures. The
 * exponential backoff is short (250ms, 500ms, 1000ms) so the
 * polling loop's 5s tick can absorb one or two retries without
 * losing the cycle. Methods other than GET also retry on network
 * errors but not on non-2xx responses (idempotency is the
 * caller's responsibility — lease acquire / release are themselves
 * idempotent through sha comparison).
 */
async function requestWithRetry(url, {
  method = "GET",
  token,
  body,
  maxRetries = DEFAULT_MAX_RETRIES,
  timeoutMs = method === "GET" ? DEFAULT_TIMEOUT_MS : DEFAULT_WRITE_TIMEOUT_MS,
  parseJson = true,
  conditional = false,
  retryTimedOutBody = true,
} = {}) {
  if (conditional && (method !== 'GET' || !parseJson)) throw new Error('Conditional reads require a JSON GET');
  const cacheKey = conditional ? createHash('sha256').update(JSON.stringify([token, url])).digest('hex') : undefined;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();
    let phase = 'headers', responseStatus;
    const cached = conditionalResponses.get(cacheKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const opts = {
        method,
        dispatcher: getAgent(),
        headers: { ...authHeaders(token), ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cached ? { "If-None-Match": cached.etag } : {}) },
        signal: controller.signal,
      };
      if (body !== undefined) opts.body = typeof body === "string" ? body : JSON.stringify(body);
      const resp = await fetchImpl(url, opts);
      phase = 'body'; responseStatus = resp.status;
      const text = await resp.text();
      phase = 'decode';
      clearTimeout(timer);
      if (resp.status === 304) {
        const etag = resp.headers?.get('etag');
        // If-None-Match uses weak comparison; GitHub can return a strong tag for a weak request tag.
        if (!cached || (etag && etag.replace(/^W\//, '') !== cached.etag.replace(/^W\//, ''))) {
          forgetConditionalResponse(cacheKey);
          throw classify(new Error('GitHub conditional response has no matching validated representation'), 304);
        }
        conditionalResponses.delete(cacheKey);
        conditionalResponses.set(cacheKey, cached); // Touch the validated entry without recompressing it.
        return JSON.parse(inflateSync(cached.packed, { maxOutputLength: cached.decodedBytes }).toString('utf8'));
      }
      if (resp.ok) {
        if (conditional) forgetConditionalResponse(cacheKey);
        if (parseJson && text) {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error('GitHub API returned invalid JSON');
          }
          if (conditional) {
            const etag = resp.headers?.get('etag');
            if (etag) rememberConditionalResponse(cacheKey, etag, text);
          }
          return parsed;
        }
        return text;
      }
      // 404/422/409/etc. on writes are caller-meaningful; classify
      // and throw without retry so the caller can decide.
      if (resp.status === 404 || resp.status === 422 || resp.status === 409) {
        throw classify(new Error(`GitHub API ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`), resp.status);
      }
      lastErr = classify(new Error(`GitHub API ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`), resp.status);
      if (!lastErr.transient || attempt === maxRetries) throw lastErr;
    } catch (networkErr) {
      clearTimeout(timer);
      // A permanent HTTP error is not a network flake, nor permission to return cached state.
      if (networkErr.status !== undefined && !networkErr.transient) {
        throw networkErr;
      }
      // DOMException.code is read-only and callers may throw frozen errors. Preserve the cause.
      lastErr = Object.assign(new Error(networkErr.status !== undefined ? `GitHub API ${networkErr.status} request failed`
        : phase === 'decode' ? 'GitHub API returned invalid JSON' : `GitHub request failed during ${phase}`, { cause: networkErr }), {
        name: networkErr?.name ?? 'Error', code: networkErr?.code, status: networkErr?.status, transient: true,
        requestTimedOut: controller.signal.aborted,
        githubRequest: requestDiagnostic(url, method, phase, attempt, startedAt, timeoutMs, responseStatus),
      });
      if (attempt === maxRetries || (!retryTimedOutBody && phase === 'body' && responseStatus === 200 && controller.signal.aborted)) throw lastErr;
    }
    await sleep(Math.min(250 * 2 ** attempt, 1_000));
  }
  throw lastErr;
}

/**
 * Convenience for GET endpoints. Identical to requestWithRetry but
 * kept as a separate export so existing Phase A call sites stay
 * readable.
 */
async function getWithRetry(url, opts = {}) {
  return requestWithRetry(url, { ...opts, method: "GET" });
}

function splitRepo(repository) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error(`Invalid repository (expected "owner/repo"): ${repository}`);
  }
  return repository.split("/", 2);
}

function mapIssueFields(raw, fields) {
  const out = {};
  if (fields.includes("number")) out.number = raw.number;
  if (fields.includes("title")) out.title = raw.title;
  if (fields.includes("body")) out.body = raw.body ?? "";
  if (fields.includes("labels")) {
    out.labels = (raw.labels ?? []).map((l) => (typeof l === "string" ? { name: l } : { name: l.name }));
  }
  if (fields.includes("author")) {
    out.author = { login: raw.user?.login ?? "unknown" };
  }
  if (fields.includes("createdAt")) out.createdAt = raw.created_at;
  if (fields.includes("updatedAt")) out.updatedAt = raw.updated_at;
  if (fields.includes("state")) out.state = raw.state;
  if (fields.includes("url")) out.url = raw.html_url;
  if (fields.includes("comments")) {
    // The REST /issues list endpoint carries only the comment COUNT
    // (bodies require a per-issue /comments fetch). Expose both so
    // callers can do cheap count-based drift detection before paying
    // for the full thread.
    out.comments = [];
    out.commentCount = Number.isFinite(raw.comments) ? raw.comments : 0;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Phase A — Read path: list open issues                                       */
/* -------------------------------------------------------------------------- */

/**
 * List all open issues for `repository` (excluding pull requests,
 * which GitHub's /issues endpoint also returns).
 */
export async function listOpenIssues({
  ...options
} = {}) {
  return listIssues({ ...options, state: "open" });
}

export async function listIssues({
  token,
  repository,
  fields = [
    "number", "title", "body", "labels", "author", "createdAt", "updatedAt", "state", "url", "comments",
  ],
  perPage = 100,
  maxPages = 10,
  state = "all",
  labels,
} = {}) {
  const [owner, repo] = splitRepo(repository);
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}&page=${page}${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`;
    const resp = await requestWithRetry(url, { method: "GET", token });
    const batch = resp;
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub issue list response");
    if (batch.length === 0) break;
    for (const raw of batch) {
      // GitHub's /issues endpoint includes pull requests — filter them.
      if (raw.pull_request) continue;
      all.push(mapIssueFields(raw, fields));
    }
    if (batch.length < perPage) break;
    if (page === maxPages) throw new Error("GitHub issue list exceeds pagination budget; refusing partial state");
  }
  return all;
}

/* -------------------------------------------------------------------------- */
/* Phase A — Read path: single issue + comments                                */
/* -------------------------------------------------------------------------- */

/**
 * Fetch one issue (label-aware, body, comments-summary). Equivalent
 * to `gh issue view N --repo X --json number,title,body,labels,...`
 * but with a persistent TLS connection.
 */
export async function closeIssue({ token, repository, number }) {
  const [owner, repo] = splitRepo(repository);
  return requestWithRetry(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, {
    method: "PATCH", token, body: { state: "closed", state_reason: "completed" }, maxRetries: 0,
  });
}

export async function fetchIssue({ token, repository, number }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  const raw = await getWithRetry(url, { token });
  return mapIssueFields(raw, [
    "number", "title", "body", "labels", "author", "createdAt", "updatedAt", "state", "url",
  ]);
}

/**
 * Fetch the full comment thread for one issue. Each entry mirrors
 * the gh-cli shape: `{ author, body, createdAt }`.
 */
export async function listIssueComments({ token, repository, number, perPage = 100 } = {}) {
  const [owner, repo] = splitRepo(repository);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error("Invalid comments page size");
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`;
  const key = createHash('sha256').update(JSON.stringify([token, base])).digest('hex');
  let pageSize = Math.min(perPage, commentPageSizes.get(key) ?? perPage);
  for (;;) {
    const comments = [];
    for (let page = 1; ; page++) {
      let raw;
      try {
        raw = await getWithRetry(`${base}?per_page=${pageSize}&page=${page}`, { token, conditional: true, retryTimedOutBody: false });
      } catch (error) {
        // Smaller bodies can fit the unchanged deadline. Permissions, headers and JSON faults cannot.
        if (pageSize === 1 || !error.requestTimedOut || error.name !== 'AbortError' || error.githubRequest?.phase !== 'body'
          || error.githubRequest.status !== 200) throw error;
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        // Restart at page one: changing page size in-place would skip or duplicate history.
        break;
      }
      if (!Array.isArray(raw)) throw new Error("GitHub comments response is not an array");
      comments.push(...raw.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: c.created_at ?? "",
        updatedAt: c.updated_at ?? c.created_at ?? "",
      })));
      if (raw.length < pageSize) {
        // Bounded performance hints only; every selected page still needs a GitHub response.
        if (pageSize < perPage) {
          commentPageSizes.delete(key);
          if (commentPageSizes.size >= 128) commentPageSizes.delete(commentPageSizes.keys().next().value);
          commentPageSizes.set(key, pageSize);
        }
        return comments;
      }
    }
  }
}

/** Identify the credential's writer without trusting marker text or an issue author. */
export async function fetchAuthenticatedUser({ token }) {
  const user = await getWithRetry("https://api.github.com/user", { token });
  if (!user?.login) throw new Error("Cannot identify the authenticated GitHub writer");
  return { login: user.login };
}

/* -------------------------------------------------------------------------- */
/* Phase B — Write path: labels                                                */
/* -------------------------------------------------------------------------- */

/**
 * Create or update a label on a repository. Idempotent upsert:
 * `POST /labels` creates (422 when the name already exists), then
 * `PATCH /labels/{name}` updates colour/description. NOTE: there is
 * NO `PUT /labels/{name}` endpoint on GitHub — the earlier PUT
 * implementation 404'd on every call and crashed syncLabel (observed
 * live on issue #29, 2026-09-17). Replaces `gh label create --force`.
 */
export async function upsertLabel({ token, repository, name, color, description }) {
  const [owner, repo] = splitRepo(repository);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`;
  const body = { name, color: color.replace(/^#/, ""), description: description ?? "" };
  try {
    return await requestWithRetry(base, { method: "POST", token, body, maxRetries: 1 });
  } catch (err) {
    // 422 = name already taken (create/update conflict on this endpoint).
    if (err.status !== 422) throw err;
    return await requestWithRetry(`${base}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      token,
      body: { color: body.color, description: body.description },
      maxRetries: 1,
    });
  }
}

/**
 * Set the exact label set on an issue. `add` is applied first,
 * `remove` is applied second (so a label listed in both ends up
 * removed). Mirrors `gh issue edit --add-label X --remove-label Y`
 * semantics without the round-trip per label.
 *
 * Idempotent: PATCH with the exact final name array is atomic on
 * GitHub's side.
 */
export async function setIssueLabels({ token, repository, number, labels }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`;
  const body = { labels: Array.from(new Set(labels)) };
  return requestWithRetry(url, { method: "PUT", token, body, maxRetries: 2 });
}

/**
 * Add or remove labels in a single call without touching the rest
 * of the issue's labels. Useful when the daemon's local cache
 * drifts from GitHub and we only want to flip a few names.
 *
 * `current` is the label-name array returned by `fetchIssue`; this
 * function applies the diff and returns the new label-name array.
 */
export async function syncIssueLabels({
  token, repository, number, current, add = [], remove = [],
}) {
  const desired = new Set(current);
  for (const name of add) desired.add(name);
  for (const name of remove) {
    if (desired.has(name)) desired.delete(name);
  }
  await setIssueLabels({ token, repository, number, labels: [...desired] });
  return [...desired];
}

/* -------------------------------------------------------------------------- */
/* Phase B — Write path: comments                                              */
/* -------------------------------------------------------------------------- */

/**
 * Post a comment on an issue. Returns the GitHub-assigned comment id
 * so callers can dedupe (the existing dedup happens via marker
 * comments that include `<!-- pi-software-factory:* -->`).
 */
export async function createIssueComment({ token, repository, number, body, maxRetries = 2 }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`;
  const resp = await requestWithRetry(url, {
    method: "POST",
    token,
    body: { body },
    maxRetries,
  });
  return resp?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* Phase B — Write path: git refs (lease lifecycle)                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve `refs/heads/factory/leases/issue-N` to its commit SHA. Returns
 * `null` if the ref does not exist (404).
 */
export async function getRef({ token, repository, ref }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(ref)}`;
  try {
    const resp = await requestWithRetry(url, { method: "GET", token, maxRetries: 1 });
    return resp?.object?.sha ?? null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Create a new git ref pointing at `sha`. Replaces
 * `gh api repos/X/git/refs -X POST -f ref=... -f sha=...`.
 */
export async function createRef({ token, repository, ref, sha }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
  return requestWithRetry(url, {
    method: "POST",
    token,
    body: { ref, sha },
    maxRetries: 1,
  });
}

/**
 * Delete a git ref. Returns true if the ref was deleted, false if it
 * didn't exist (404). Replaces
 * `gh api repos/X/git/refs/... -X DELETE`.
 */
export async function deleteRef({ token, repository, ref }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${encodeURIComponent(ref)}`;
  try {
    await requestWithRetry(url, { method: "DELETE", token, maxRetries: 1, parseJson: false });
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 422) return false;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Phase B — Write path: lease commit (the lease acquire flow)                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve `heads/<branch>` (or any short ref) to its commit SHA via
 * `git ref/heads/<branch>`. Used by the lease to anchor a new
 * commit off the current default-branch tip.
 */
export async function getBranchSha({ token, repository, branch }) {
  return getRef({ token, repository, ref: `heads/${branch}` });
}

/**
 * Resolve a commit SHA to its tree SHA (used when creating a lease
 * commit that has no file changes — the new commit just re-anchors
 * the existing tree at a new SHA).
 */
export async function getCommitTree({ token, repository, sha }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`;
  const resp = await requestWithRetry(url, { method: "GET", token, maxRetries: 1 });
  return resp?.tree?.sha ?? null;
}

/**
 * Create a new commit (no parent diff — the commit simply re-anchors
 * the tree at a new SHA, which is what the lease acquire flow
 * needs). Replaces
 * `gh api repos/X/git/commits -X POST -f message=... -f tree=... -f parents[]=...`.
 */
export async function createCommit({ token, repository, message, tree, parents }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`;
  return requestWithRetry(url, {
    method: "POST",
    token,
    body: { message, tree, parents },
    maxRetries: 1,
  });
}

/**
 * Resolve a commit SHA to its commit message. The lease's stale-reclaim
 * inspect path needs the message to parse `owner=` and `ts=`
 * before deciding whether to override a fresh lease.
 */
export async function getCommitMessage({ token, repository, sha }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`;
  const resp = await requestWithRetry(url, { method: "GET", token, maxRetries: 1 });
  return typeof resp?.message === "string" ? resp.message : null;
}

/* -------------------------------------------------------------------------- */
/* Phase B — Write path: pull requests (publish flow)                           */
/* -------------------------------------------------------------------------- */

/**
 * Open a pull request. Replaces
 * `gh pr create --base X --head Y --title T --body B`.
 * Returns the parsed PR object on success; throws on validation
 * errors (422) so the caller can surface the GitHub message.
 */
export async function openPullRequest({
  token, repository, head, base, title, body, draft = false,
}) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  return requestWithRetry(url, {
    method: "POST",
    token,
    body: { title, head, base, body, draft },
    maxRetries: 1,
  });
}

/**
 * List pull requests. `head` must be in GitHub's `owner:branch`
 * format. Replaces `gh pr list --head X --base Y --state open`.
 */
export async function listPullRequests({
  token, repository, state = "open", head, base, perPage = 100,
}) {
  const [owner, repo] = splitRepo(repository);
  const params = new URLSearchParams({ state: String(state), per_page: String(perPage) });
  if (head) params.set("head", String(head));
  if (base) params.set("base", String(base));
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`;
  const resp = await getWithRetry(url, { token });
  return Array.isArray(resp) ? resp : [];
}

/**
 * Fetch a single pull request by number (used to verify the head
 * SHA after open / before merge).
 */
export async function fetchPullRequest({ token, repository, number }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  return getWithRetry(url, { token });
}

/**
 * Merge a pull request. `mergeMethod` defaults to "squash"; git.ts
 * passes "merge" to match the factory's historical `gh pr merge
 * --merge` behaviour. `sha` pins the expected head SHA — GitHub
 * refuses with 409 when the PR head has moved (the REST equivalent
 * of `--match-head-commit`). Replaces `gh pr merge`.
 */
export async function mergePullRequest({
  token, repository, number, commitMessage, mergeMethod = "squash", sha,
}) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`;
  return requestWithRetry(url, {
    method: "PUT",
    token,
    body: {
      ...(commitMessage !== undefined ? { commit_message: commitMessage } : {}),
      merge_method: mergeMethod,
      ...(sha ? { sha } : {}),
    },
    maxRetries: 1,
  });
}

/* -------------------------------------------------------------------------- */
/* Test-only escape hatch                                                     */
/* -------------------------------------------------------------------------- */

export { getWithRetry as _test_getWithRetry };

/** GitHub's matching-refs endpoint returns the entire matching namespace. */
export async function listLeaseRefs({ token, repository }) {
  const [owner, repo] = splitRepo(repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/matching-refs/heads/factory/leases/`;
  const rows = await getWithRetry(url, { token });
  if (!Array.isArray(rows)) throw new Error("Invalid GitHub lease ref response");
  return rows.map((row) => {
    const match = row.ref?.match(/^refs\/heads\/factory\/leases\/issue-(\d+)$/);
    if (!match || !row.object?.sha) throw new Error("Malformed factory lease ref");
    return { issueNumber: Number(match[1]), ref: row.ref, sha: row.object.sha };
  });
}
