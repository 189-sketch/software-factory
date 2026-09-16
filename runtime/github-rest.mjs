/**
 * GitHub REST API client for the factory daemon's hot path.
 *
 * Why this exists
 * ───────────────
 * The daemon polls the issue list every few seconds. Each poll used
 * to shell out to the `gh` CLI via Node's `execFile`, which on this
 * Windows host reliably fails after the daemon has been alive for
 * several minutes (the user can run `gh issue list` from their shell
 * with no problem). The failure mode is `net/http: TLS handshake
 * timeout` or `Post ... EOF` reported by the gh child process — i.e.
 * the gh binary inside the daemon's process tree can't keep a TLS
 * session to api.github.com alive, but gh from a fresh user shell
 * can. We can't reliably reproduce or patch the long-running-state
 * failure, so we route the hot path through Node's `fetch` with a
 * persistent undici Agent. One TLS handshake, every poll reuses it.
 *
 * Trade-offs vs the gh CLI
 * ───────────────────────
 * - `gh` is still used for the rest: git push, gh pr create, gh
 *   api mutations. Those are infrequent (only when an agent
 *   publishes) and don't suffer the long-running-state problem
 *   the same way. The polling path is the only one that needs a
 *   persistent client.
 * - We lose gh's auto-auth (`gh auth status`): this module requires
 *   an explicit `token` parameter. The factory daemon reads
 *   `GH_TOKEN` (or `GITHUB_TOKEN`) and passes it through.
 * - Pagination: `gh` returns up to `--limit 1000` in one call; this
 *   module paginates with `per_page` + `page` and follows until the
 *   response is short or `maxPages` is exhausted. Default 10 pages
 *   × 100 = 1000 issues, the same effective bound.
 *
 * Concurrency
 * ───────────
 * The Agent is module-scoped and shared across all `listOpenIssues`
 * calls. The fetch dispatcher is a singleton so the underlying
 * connection pool reuses sockets per host. `forceClose()` is the
 * call-site's escape hatch for tests that need to release sockets.
 */

import { Agent, fetch } from "undici";

const USER_AGENT = "software-factory-cli";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

/**
 * Single GET with bounded retries on transient failures. The
 * exponential backoff is intentionally short (250ms, 500ms, 1000ms)
 * so the polling loop's 5s tick can absorb one or two retries
 * without losing the cycle.
 */
async function getWithRetry(url, { token, maxRetries = DEFAULT_MAX_RETRIES } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        dispatcher: getAgent(),
        headers: authHeaders(token),
      });
      if (resp.ok) return resp;
      const body = await resp.text().catch(() => "");
      const err = new Error(`GitHub API ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`);
      err.status = resp.status;
      err.transient = RETRYABLE_STATUS.has(resp.status);
      lastErr = err;
      if (!err.transient || attempt === maxRetries) throw err;
    } catch (networkErr) {
      lastErr = networkErr;
      networkErr.transient = true;
      if (attempt === maxRetries) throw networkErr;
    }
    // Backoff: 250ms, 500ms, 1000ms (capped).
    await sleep(Math.min(250 * 2 ** attempt, 1_000));
  }
  // Unreachable; the loop either returns or throws.
  throw lastErr;
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
  if (fields.includes("url")) out.url = raw.html_url;
  // comments are deliberately not part of the list payload — the
  // caller fetches them per-issue when needed.
  if (fields.includes("comments")) out.comments = [];
  return out;
}

/**
 * List all open issues for `repository` (excluding pull requests,
 * which GitHub's /issues endpoint also returns).
 *
 * @param {object}   options
 * @param {string}   options.token         GitHub PAT or installation token.
 * @param {string}   options.repository   "owner/repo" string.
 * @param {string[]} options.fields       Optional field allowlist; defaults
 *                                        to the historical gh-issue-list
 *                                        --json field set.
 * @param {number}   options.perPage      Page size (max 100).
 * @param {number}   options.maxPages     Safety cap so a runaway
 *                                        paginator can't issue infinite
 *                                        requests.
 */
export async function listOpenIssues({
  token,
  repository,
  fields = [
    "number", "title", "body", "labels", "author", "createdAt", "url", "comments",
  ],
  perPage = 100,
  maxPages = 10,
} = {}) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error(`Invalid repository (expected "owner/repo"): ${repository}`);
  }
  const [owner, repo] = repository.split("/", 2);
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=${perPage}&page=${page}`;
    const resp = await getWithRetry(url, { token });
    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const raw of batch) {
      // GitHub's /issues endpoint includes pull requests — filter them.
      if (raw.pull_request) continue;
      all.push(mapIssueFields(raw, fields));
    }
    if (batch.length < perPage) break;
  }
  return all;
}
