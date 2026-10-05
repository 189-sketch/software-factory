import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { formatUtc8Timestamp } from "../runtime/time.mjs";
import { stageForLabel } from "../runtime/pipeline-definition.mjs";

const execFileAsync = promisify(execFile);

/**
 * Normalise execFile/execFileSync output to a string. execFile's
 * callback-style API returns Buffers by default, which JSON.stringify
 * serialises as `{"type":"Buffer","data":[...]}`. Callers that pass
 * the result straight into JSON.parse (e.g. fetchNextFromGitHub on
 * `gh issue list --json ...`) then crash with `SyntaxError: ... is
 * not valid JSON` or get the unhelpful `"[object Object]"` preview.
 * execFileSync returns strings when `encoding` is set; this helper
 * handles both shapes.
 */
function coerceToString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map(coerceToString).join("");
  return String(value);
}

/**
 * Normalise the result of a `runNetworkCommand` / `runCommandWithRetry`
 * call to a plain string of stdout.
 *
 * `runCommandWithRetry` has two return shapes:
 *   - sync path:  a bare string (what `execFileSync` returns when
 *                  `encoding` is set)
 *   - async path: `{ stdout, stderr }` (what the callback-style
 *                  `execFile` resolves with in the Windows-kill fix)
 *
 * When a caller `JSON.parse`s the value directly it gets the unhelpful
 * `"[object Object]" is not valid JSON` SyntaxError, because the async
 * path returns an object and `JSON.parse` coerces it via `String()`.
 * The daemon's gh callers all funnel through this helper so any future
 * contract change is a one-line update here, not a sweep across every
 * call site.
 */
export function parseStdout(result) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "stdout" in result) {
    return coerceToString(result.stdout);
  }
  return coerceToString(result);
}

// Re-export for backwards compatibility with callers (and tests) that
// imported `formatUtc8Timestamp` from this module before the helper
// was extracted to `runtime/time.mjs`.
export { formatUtc8Timestamp };

const TRANSIENT_NETWORK_PATTERNS = [
  /\bEOF\b/i,
  /early eof/i,
  /unexpected (?:disconnect|end of file)/i,
  /connection (?:reset|refused|timed out)/i,
  /could not resolve host/i,
  /temporary failure/i,
  /network is unreachable/i,
  /remote end hung up/i,
  /failed to connect/i,
  /TLS handshake timeout/i,
  /stream error/i,
  // execFileSync's `timeout` option throws ETIMEDOUT when the child is
  // killed. Treat it as transient — the retry wrapper gives the next
  // attempt a fresh subprocess and a chance to recover.
  /\bETIMEDOUT\b/i,
  /HTTP (?:408|429|5\d\d)\b/i,
  /status code (?:408|429|5\d\d)\b/i,
];

export function commandErrorText(error) {
  if (!error || typeof error !== "object") return String(error);
  const parts = [error.message, error.stderr, error.stdout]
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .map(String);
  return parts.join("\n");
}

export function isTransientNetworkError(error) {
  const text = commandErrorText(error);
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Per-operation retry policies. The default (`standard`) keeps the
 * legacy 3-attempt, 1s-base, 8s-cap envelope. `critical` operations
 * (label sync, PR open/merge, lease acquire) tolerate more attempts
 * with a longer cap because losing them strands the pipeline.
 *
 * Both envelopes now jitter ±25 % on the back-off so a flapping
 * endpoint doesn't make every daemon worker retry in lock-step
 * (the GitHub API has shown packet-loss bursts that synchronise
 * across instances).
 */
export const RETRY_POLICIES = Object.freeze({
    standard: Object.freeze({ attempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 }),
    critical: Object.freeze({ attempts: 6, baseDelayMs: 1_500, maxDelayMs: 30_000 }),
});

function jitter(ms, ratio = 0.25) {
    const delta = ms * ratio;
    return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * delta));
}

export async function retryTransient(operation, options = {}) {
  const policyName = options.policy ?? "standard";
  const policy = RETRY_POLICIES[policyName] ?? RETRY_POLICIES.standard;
  const attempts = options.attempts ?? policy.attempts;
  const baseDelayMs = options.baseDelayMs ?? policy.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? policy.maxDelayMs;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const transient = isTransientNetworkError(error);
      if (!transient || attempt === attempts) {
        if (transient && error && typeof error === "object") {
          error.factoryTransientNetworkFailure = true;
        }
        throw error;
      }
      const baseDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = jitter(baseDelay);
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error, policy: policyName });
      await sleep(delayMs);
    }
  }
  throw new Error("retryTransient exhausted without returning or throwing");
}

/**
 * Wrap execFileSync with a default timeout so a hung child (gh or git on
 * Windows after a transport-level EOF can leave the subprocess zombie and
 * the second execFileSync call blocks indefinitely) cannot wedge the
 * daemon. Callers can override `timeout` via commandOptions or
 * `context.timeoutMs` (e.g. force-clear uses a shorter 10s budget so a
 * flaky `gh issue list` does not gate the daemon's main poll loop for
 * the full critical-policy envelope).
 */
// Reduced from 30s → 10s on 2026-09-15: the previous default matched
// POLL_INTERVAL (30s), so a single critical-policy run of 6 attempts
// against an unreachable GitHub (each hitting the 30s execFileSync
// timeout) blocked the daemon for ~3.7 minutes per tick — longer than
// POLL_INTERVAL — and made the loop-backoff table effectively unused.
// 10s keeps the same coverage for legitimate slow requests while
// collapsing one failing tick to ~1.5 minutes (6 × 10s + 46s of
// inter-attempt back-off), so the daemon tick cadence actually tracks
// POLL_INTERVAL under transient GitHub flakes.
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const SHORT_COMMAND_TIMEOUT_MS = 5_000;

export function runCommandWithRetry(command, args, commandOptions = {}, retryOptions = {}) {
  // Default to the async execFile path because Windows `execFileSync` does
  // not reliably kill a hung child when the timeout fires — the daemon
  // sits in a syscall waiting for the child to exit and never returns to
  // the retry wrapper, so a hung child can stall the caller indefinitely.
  // The async path lets us attach an explicit timer and `child.kill()` (or
  // `taskkill /T /F` on win32) so the timeout actually unblocks the caller
  // and the retry wrapper sees the failure.
  //
  // Callers may still opt back into the sync path by passing
  // `retryOptions.execFileSync` (preserved for any caller that depends
  // on the synchronous semantics).
  const useSync = typeof retryOptions.execFileSync === "function";
  if (useSync) {
    let options;
    if (commandOptions.timeout != null) {
      options = commandOptions;
    } else if (retryOptions.timeoutMs === 'short') {
      options = { ...commandOptions, timeout: SHORT_COMMAND_TIMEOUT_MS };
    } else {
      options = { ...commandOptions, timeout: DEFAULT_COMMAND_TIMEOUT_MS };
    }
    return retryTransient(
      () => retryOptions.execFileSync(command, args, options),
      retryOptions,
    );
  }
  let timeoutMs;
  if (commandOptions.timeout != null) {
    timeoutMs = commandOptions.timeout;
  } else if (retryOptions.timeoutMs === 'short') {
    timeoutMs = SHORT_COMMAND_TIMEOUT_MS;
  } else {
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
  }
  // Pull through stdio + env from commandOptions. Strip the sync-only
  // `timeout` field; the async path enforces it via kill timer.
  const { timeout: _ignored, ...asyncOptions } = commandOptions;
  return retryTransient(
    () => runCommandWithTimeoutAsync(command, args, asyncOptions, timeoutMs),
    retryOptions,
  );
}

async function runCommandWithTimeoutAsync(command, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    let killed = false;
    const killTimer = setTimeout(() => {
      if (!child || killed) return;
      killed = true;
      try {
        if (process.platform === "win32") {
          // Best-effort kill of the child tree (gh often spawns its own
          // helper subprocesses via cmd.exe); execFile's `kill` only
          // signals the top-level pid on Windows, which leaves a zombie
          // gh.exe hanging and breaks the next retry. taskkill /T /F
          // walks the tree.
          try {
            execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          } catch {}
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    }, timeoutMs);
    try {
      // Force `encoding: 'utf8'` so stdout/stderr are strings, matching
      // the shape `execFileSync` returns. The callback-style execFile
      // defaults to Buffer when `encoding` is null, which then propagates
      // as "[object Object]" into the JSON.parse in fetchNextFromGitHub.
      // We accept whatever the caller passed (e.g. 'utf-8' from the
      // factory daemon), defaulting only when the caller omitted it.
      child = execFile(command, args, {
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        ...options,
      }, (error, stdout, stderr) => {
        clearTimeout(killTimer);
        if (killed) {
          // Mimic the exact error shape `execFileSync` produces when its
          // `timeout` option fires (ETIMEDOUT in the message + .code),
          // so existing TRANSIENT_NETWORK_PATTERNS (which include
          // /\bETIMEDOUT\b/i and /connection (timed out)/i) match and
          // the retry wrapper treats the kill as transient, not fatal.
          const err = new Error(`${command} ETIMEDOUT after ${timeoutMs}ms`);
          err.code = "ETIMEDOUT";
          err.signal = "SIGTERM";
          err.stdout = coerceToString(stdout);
          err.stderr = coerceToString(stderr);
          err.killed = true;
          reject(err);
          return;
        }
        if (error) {
          // Preserve the shape callers expect from execFileSync's throw —
          // message, code, stdout, stderr. execFile's callback error
          // already carries these on Node 22+.
          if (!error.message) error.message = `${command} exited with code ${error.code ?? "?"}`;
          // Some error shapes put stdout/stderr directly on the error
          // object — `commandErrorText` reads both. Normalise Buffers
          // to strings so JSON-stringified errors are readable.
          error.stdout = coerceToString(error.stdout);
          error.stderr = coerceToString(error.stderr);
          reject(error);
          return;
        }
        resolve({ stdout: coerceToString(stdout), stderr: coerceToString(stderr) });
      });
      child.on("error", (error) => {
        clearTimeout(killTimer);
        if (killed) return;
        reject(error);
      });
    } catch (error) {
      clearTimeout(killTimer);
      reject(error);
    }
  });
}

function gitOutput(repo, args, run = execFileSync) {
  return String(run("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })).trim();
}

export function isGitWorktree(directory, run = execFileSync) {
  if (!fs.existsSync(directory)) return false;
  try {
    const top = gitOutput(directory, ["rev-parse", "--show-toplevel"], run);
    return path.resolve(top) === path.resolve(directory);
  } catch {
    return false;
  }
}

export function detectDefaultBranch(repo, configuredBranch, configuredExplicitly, run = execFileSync) {
  if (configuredExplicitly) return configuredBranch;
  try {
    const remoteHead = gitOutput(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], run);
    const detected = remoteHead.replace(/^origin\//, "");
    if (detected) return detected;
  } catch {}
  try {
    const detected = gitOutput(repo, ["branch", "--show-current"], run);
    if (detected) return detected;
  } catch {}
  return configuredBranch;
}

export async function ensureIssueWorktree(options) {
  const {
    workdir,
    issueNumber,
    sourceRepo,
    defaultBranch,
    run = execFileSync,
    onEvent = () => {},
  } = options;
  if (!isGitWorktree(sourceRepo, run)) {
    throw new Error(`Worktree source is not a git repository root: ${sourceRepo}`);
  }

  const issueWorkdir = path.join(workdir, `issue-${issueNumber}`);
  fs.mkdirSync(workdir, { recursive: true });

  if (fs.existsSync(issueWorkdir)) {
    if (!isGitWorktree(issueWorkdir, run)) {
      throw new Error(`Issue worktree path exists but is not a git worktree: ${issueWorkdir}`);
    }
    onEvent("worktree-reused", { issue: issueNumber, src: sourceRepo, dst: issueWorkdir });
    return issueWorkdir;
  }

  run("git", ["-C", sourceRepo, "worktree", "prune"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let baseRef = `origin/${defaultBranch}`;
  try {
    gitOutput(sourceRepo, ["rev-parse", "--verify", baseRef], run);
  } catch {
    try {
      gitOutput(sourceRepo, ["rev-parse", "--verify", defaultBranch], run);
      baseRef = defaultBranch;
    } catch {
      baseRef = "HEAD";
    }
  }
  run("git", ["-C", sourceRepo, "worktree", "add", "--detach", issueWorkdir, baseRef], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  onEvent("worktree-created", { issue: issueNumber, src: sourceRepo, dst: issueWorkdir, base: baseRef });
  return issueWorkdir;
}

/**
 * Decide whether the polling loop may leave a `waiting` issue parked
 * (skip it silently this poll) or MUST pick it up to resume the
 * pipeline.
 *
 * Parking is only correct when the pipeline genuinely waits for an
 * EXTERNAL actor:
 *   - nextLabel maps to the `triage` stage (needs-info,
 *     wait-to-implement) — waiting for the author/operator; the
 *     needs-info comment-change branch handles wake-up separately.
 *   - nextLabel is `verified` and autoMerge is off — waiting for a
 *     human to merge the PR.
 *   - nextLabel is `verify-failed` with a blocked behavior
 *     verification — mirrors the orchestrator's own park (it returns
 *     the state immediately without dispatching).
 *
 * Every other label (ready-to-implement, ready-to-spec, review-needed,
 * ready-to-merge, changes-requested, ...) is a RUNNABLE stage: a
 * `waiting` exit with such a label means "resume me on the next poll"
 * (e.g. the triage supervisor scheduled an implementation retry after
 * a timeout). The old unconditional label-match park deadlocked issue
 * #29 in exactly that state: nothing would ever change the issue
 * content, so no poll would pick it up again.
 *
 * @param {object} input
 * @param {{ status?: string, error?: string|null, nextLabel?: string|null,
 *           implementation?: { behaviorVerification?: { status?: string } } }|null} input.checkpoint
 * @param {string[]} input.factoryLabels  ACTIVE factory labels present on the GitHub issue
 * @param {string[]} [input.retiredLabels] RETIRED factory labels present on the issue
 * @param {boolean} input.unchanged        issue body+comments identical to the checkpoint
 * @param {boolean} [input.autoMerge]      FACTORY_AUTO_MERGE resolved by the daemon
 * @returns {boolean} true when the poll may skip the issue
 */
export function shouldParkWaitingIssue({ checkpoint, factoryLabels, retiredLabels = [], unchanged, autoMerge = false }) {
  if (!checkpoint || checkpoint.status !== "waiting" || checkpoint.error) return false;
  if (!unchanged) return false;
  if (retiredLabels.length > 0) return false; // retired labels always wake the orchestrator for cleanup
  const nextLabel = checkpoint.nextLabel;
  if (!nextLabel) return false;
  if (factoryLabels.length !== 1 || factoryLabels[0] !== nextLabel) return false;
  if (nextLabel === "verified") return checkpoint.wait?.reason === 'blocked-operator' || !autoMerge;
  if (nextLabel === "verify-failed") {
    return checkpoint.wait?.reason === 'blocked-operator' || checkpoint.implementation?.behaviorVerification?.status === "blocked";
  }
  return stageForLabel(nextLabel) === "triage";
}
