import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

export function formatUtc8Timestamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace(/Z$/, "+08:00");
}

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

export async function retryTransient(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
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
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new Error("retryTransient exhausted without returning or throwing");
}

/**
 * Wrap execFileSync with a default timeout so a hung child (gh or git on
 * Windows after a transport-level EOF can leave the subprocess zombie and
 * the second execFileSync call blocks indefinitely) cannot wedge the
 * daemon. Callers can override `timeout` via commandOptions.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export function runCommandWithRetry(command, args, commandOptions = {}, retryOptions = {}) {
  const run = retryOptions.execFileSync ?? execFileSync;
  const options = commandOptions.timeout == null
    ? { ...commandOptions, timeout: DEFAULT_COMMAND_TIMEOUT_MS }
    : commandOptions;
  return retryTransient(
    () => run(command, args, options),
    retryOptions,
  );
}

export function loopBackoffMs(consecutiveFailures, pollIntervalMs, maximumMs = 15 * 60 * 1000) {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  return Math.min(pollIntervalMs * 2 ** exponent, maximumMs);
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
