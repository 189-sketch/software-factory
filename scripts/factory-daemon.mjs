#!/usr/bin/env node
/**
 * Local factory daemon: polls a target GitHub repo for new issues and
 * processes them on the local machine. Secrets stay local; only finished
 * commits/PRs reach github.com.
 *
 * Usage:
 *   # Option 1: poll a remote GitHub repo
 *   FACTORY_GH_REPO=owner/name \
 *   GH_TOKEN=ghp_... \
 *   ANTHROPIC_AUTH_TOKEN=sk-... \
 *   node scripts/factory-daemon.mjs --interval 60
 *
 *   # Option 2: watch a local directory for issue JSON files (offline / dev)
 *   node scripts/factory-daemon.mjs --local-dir ./issues --interval 5
 *
 *   # Option 3: GitHub webhook (real-time, server required)
 *   node scripts/factory-daemon.mjs --webhook-port 8080
 *
 *   # Option 4: run the daily review improvement loop once
 *   node scripts/factory-daemon.mjs --daily
 *
 * Run modes can be combined: --local-dir + --webhook-port, etc.
 *
 * The daemon handles each issue end-to-end (triage → spec → implement →
 * review → verify → push). Durable issue checkpoints are stored under
 * <state-dir>/issues and execution summaries under <state-dir>/state-<n>.json.
 */
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { classifyPipelineOutcome } from "./pipeline-outcome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

function getEnv(name, fallback) {
  return process.env[name] || fallback;
}

const args = parseArgs(process.argv.slice(2));

// Load env from .env file FIRST (before reading any process.env below).
// Default to .factory-daemon/.env so the installer-wrapped start.sh /
// start.cmd don't have to shell-parse dotenv files (which is brittle on
// Windows .cmd). Explicit --env-file=path wins; pass --no-env-file to skip.
const SKIP_ENV_FILE = args.noEnvFile === true || args.envFile === "-";
if (!SKIP_ENV_FILE) {
  const envPath = (typeof args.envFile === "string" && args.envFile.length)
    ? path.resolve(args.envFile)
    : path.resolve(process.cwd(), ".factory-daemon", ".env");
  if (fsSync.existsSync(envPath)) {
    loadDotEnv(envPath);
  }
}

const STATE_DIR = path.resolve(args.stateDir || process.env.FACTORY_STATE_DIR || path.join(process.cwd(), ".factory"));
fsSync.mkdirSync(STATE_DIR, { recursive: true });
const DAEMON_LOCK = acquireDaemonLock();
process.on("exit", () => releaseDaemonLock(DAEMON_LOCK));

/**
 * Apply fallback env sources, in order, ONLY where the variable is not
 * already set. Real shell env wins. Caller can disable via --no-fallback-env.
 *
 *  1. ~/.claude/settings.json  → pulls ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
 *                                ANTHROPIC_MODEL (the user's local Claude Code
 *                                config — reuses credentials you've
 *                                already authorised there).
 *  2. gh CLI                   → if `gh auth status` succeeds, use the
 *                                authenticated account's token for GH_TOKEN.
 *                                Avoids forcing users to set GH_TOKEN when
 *                                they've already done `gh auth login`.
 *
 * The defaults are minimaxi (per project README) so the daemon is usable
 * with just `~/.claude/settings.json` or the env vars, no manual config.
 */
function applyEnvFallbacks() {
  const sources = [];

  // (1) ~/.claude/settings.json — only fill unset keys.
  const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
  if (fsSync.existsSync(claudeSettings)) {
    try {
      const json = JSON.parse(fsSync.readFileSync(claudeSettings, "utf-8"));
      if (json && typeof json.env === "object" && json.env !== null) {
        let loaded = 0;
        for (const [k, v] of Object.entries(json.env)) {
          if (process.env[k] === undefined && v !== undefined && v !== null) {
            process.env[k] = String(v);
            loaded++;
          }
        }
        if (loaded > 0) sources.push({ source: "claude-settings", count: loaded });
      }
    } catch (err) {
      // ignore — file may not be JSON
    }
  }

  // (2) gh CLI fallback for GH_TOKEN.
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    try {
      const out = execFileSync("gh", ["auth", "token"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        process.env.GH_TOKEN = out;
        sources.push({ source: "gh-cli", count: 1 });
      }
    } catch {
      // gh CLI not installed or not logged in — fallback unavailable.
    }
  }

  return sources;
}

/**
 * Minimal .env loader. KEY=VALUE, lines starting with # are comments, empty
 * lines skipped, optional surrounding quotes trimmed, existing process.env
 * wins (so real shell env still overrides .env). Not exported; scoped here.
 */
function loadDotEnv(file) {
  const text = fsSync.readFileSync(file, "utf-8");
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      // Skip installer-style placeholder values (ghp_replace_me / sk-..._replace_me)
      // so fallback layers (gh-cli auth, ~/.claude/settings.json) still kick in.
      if (!val || /replace[_ ]?me|^ghp_$|^sk-(ant-)?$/i.test(val)) continue;
      process.env[key] = val;
      loaded++;
    }
  }
  return loaded;
}

const log = (level, msg, extra = {}) => {
  const ts = new Date().toISOString();
  const line = `${ts} ${level} ${msg} ${JSON.stringify(extra)}`;
  console.log(line);
  fsSync.appendFileSync(path.join(STATE_DIR, "daemon.log"), line + "\n");
};

// Apply env fallbacks AFTER the .env load + AFTER log() is defined so we can
// record which sources actually contributed. --no-fallback-env disables.
const envSources = args.noFallbackEnv ? [] : applyEnvFallbacks();
if (envSources.length > 0) {
  log("INFO", "env-fallbacks-applied", { sources: envSources });
}

const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "";
const LLM_CONFIGURED = Boolean(ANTHROPIC_AUTH_TOKEN && ANTHROPIC_BASE_URL && ANTHROPIC_MODEL);
const FACTORY_GH_REPO = getEnv("FACTORY_GH_REPO", args.repo || "");
const POLL_INTERVAL = Number(args.interval || process.env.FACTORY_POLL_INTERVAL || 30);
const WEBHOOK_PORT = Number(args.webhookPort || process.env.FACTORY_WEBHOOK_PORT || 0);
const LOCAL_DIR = args.localDir || process.env.FACTORY_LOCAL_DIR || "";
const WORKDIR = path.resolve(args.workdir || process.env.FACTORY_WORKDIR || (LOCAL_DIR
  ? path.join(process.cwd(), "factory-workdir")
  : path.join(os.tmpdir(), "factory-workdir-" + Date.now())));
const DRY_RUN = args.dry || "";
const AGENT_MODE = "llm";
const WEBHOOK_SECRET = process.env.FACTORY_WEBHOOK_SECRET || "";
const RUN_TIMEOUT_MS = Math.min(Math.max(Number(process.env.FACTORY_RUN_TIMEOUT_MS || 3_600_000), 10_000), 7_200_000);
const MAX_CHILD_OUTPUT = 16 * 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--webhook-port") out.webhookPort = argv[++i];
    else if (a === "--local-dir") out.localDir = argv[++i];
    else if (a === "--workdir") out.workdir = argv[++i];
    else if (a === "--state-dir") out.stateDir = argv[++i];
    else if (a === "--dry-run") out.dry = argv[++i];
    else if (a === "--once") out.once = true;
    else if (a === "--daily") out.daily = true;
    else if (a === "--env-file") {
      // `--env-file path`, `--env-file=path`, or `--env-file -` to skip.
      const next = argv[i + 1];
      if (next === undefined) { out.envFile = ""; }
      else if (next.startsWith("=")) { out.envFile = next.slice(1); i++; }
      else { out.envFile = next; i++; }
    }
    else if (a === "--no-env-file") out.noEnvFile = true;
    else if (a === "--no-fallback-env") out.noFallbackEnv = true;
  }
  return out;
}

/**
 * Search the system PATH for an executable. Returns the absolute path of
 * the first match, or null. Used to spawn .cmd / .bat on Windows without
 * invoking cmd.exe (which Node 22+ blocks without shell: true, and which
 * also produces a deprecation warning around argument escaping).
 */
function findOnPath(name) {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
  const pathext = (process.env.PATHEXT || "").split(";").map((s) => s.toLowerCase());
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const st = fsSync.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {}
    if (process.platform === "win32") {
      // Try the bare name; on Windows, exec handles PATHEXT for .cmd/.exe.
      for (const ext of pathext) {
        const c2 = candidate + ext;
        try {
          const st = fsSync.statSync(c2);
          if (st.isFile()) return c2;
        } catch {}
      }
    }
  }
  return null;
}

/**
 * Returns null when there are no new issues.
 */
async function fetchNextIssue() {
  if (LOCAL_DIR) {
    return await fetchNextFromLocalDir();
  }
  if (FACTORY_GH_REPO && GH_TOKEN) {
    return await fetchNextFromGitHub();
  }
  return null;
}

async function fetchNextFromLocalDir() {
  if (!fsSync.existsSync(LOCAL_DIR)) return null;
  const entries = await fs.readdir(LOCAL_DIR);
  entries.sort();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(LOCAL_DIR, name);
    const content = await fs.readFile(filePath, "utf-8");
    try {
      const issue = JSON.parse(content);
      const processingDir = path.join(LOCAL_DIR, ".processing");
      await fs.mkdir(processingDir, { recursive: true });
      const claimedPath = path.join(processingDir, name);
      await fs.rename(filePath, claimedPath);
      issue._sourceFile = claimedPath;
      issue._sourceName = name;
      log("INFO", "picked-up-issue-from-local", { issue: issue.number, file: name });
      return issue;
    } catch (err) {
      log("WARN", "bad-issue-file", { file: name, error: String(err) });
      await fs.mkdir(path.join(LOCAL_DIR, ".failed"), { recursive: true });
      await fs.rename(filePath, path.join(LOCAL_DIR, ".failed", name)).catch(() => {});
    }
  }
  return null;
}

async function fetchNextFromGitHub() {
  try {
    const out = execFileSync("gh", [
      "issue", "list",
      "--repo", FACTORY_GH_REPO,
      "--state", "open",
      "--json", "number,title,body,labels,author,createdAt,url,comments",
      "--limit", "1000",
    ], { encoding: "utf-8", env: { ...process.env, GH_TOKEN } });
    const issues = JSON.parse(out);
    // Sort by createdAt ascending so we process oldest first.
    issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const issue of issues) {
      // `fetched-N` is a transient in-flight marker. Durable checkpoints,
      // issue content and workflow labels decide whether an issue needs work.
      const fetchedKey = `fetched-${issue.number}`;
      if (fsSync.existsSync(path.join(STATE_DIR, fetchedKey))) continue;
      const labelNames = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      const comments = normalizeIssueComments(issue.comments);
      const checkpoint = await readCheckpoint(issue.number);
      const unchanged = checkpoint && JSON.stringify([
        checkpoint.issue?.body || "",
        normalizeIssueComments(checkpoint.issue?.comments),
      ]) === JSON.stringify([issue.body || "", comments]);
      const factoryLabels = labelNames.filter((label) => FACTORY_LABELS.has(label));
      if (checkpoint?.status === "waiting" && !checkpoint.error && unchanged &&
          checkpoint.nextLabel && factoryLabels.length === 1 && factoryLabels[0] === checkpoint.nextLabel) {
        continue;
      }
      if (labelNames.includes("needs-info") && unchanged) continue;
      log("INFO", "picked-up-issue-from-github", { issue: issue.number, title: issue.title });
      // Claim the issue for this poll cycle. processIssue() removes this
      // file if it fails so the next poll retries; on success it writes
      // the permanent `processed-N` marker instead.
      fsSync.writeFileSync(path.join(STATE_DIR, fetchedKey), new Date().toISOString());
      // Materialize to a temp issue.json for the CLI.
      const issuePath = path.join(STATE_DIR, `issue-${issue.number}.json`);
      await fs.writeFile(issuePath, JSON.stringify({
        number: issue.number,
        title: issue.title,
        body: issue.body || "",
        labels: labelNames,
        author: issue.author?.login || "unknown",
        url: issue.url,
        createdAt: issue.createdAt,
        comments,
      }, null, 2));
      return { ...issue, _issuePath: issuePath };
    }
  } catch (err) {
    log("WARN", "gh-issue-list-failed", { error: String(err) });
    throw err;
  }
  return null;
}

const FACTORY_LABELS = new Set([
  "ready-to-implement", "ready-to-spec", "spec-ready-for-review", "needs-info",
  "wait-to-implement", "review-needed", "ready-to-merge", "verified",
  "verify-failed", "changes-requested",
]);

function normalizeIssueComments(comments) {
  return (comments || [])
    .map((comment) => ({
      author: comment.author?.login || comment.author || "unknown",
      body: comment.body || "",
      createdAt: comment.createdAt || "",
    }))
    .filter((comment) => !comment.body.includes("<!-- pi-software-factory:triage:"));
}

async function fetchIssueFromGitHub(number) {
  const out = execFileSync("gh", [
    "issue", "view", String(number),
    "--repo", FACTORY_GH_REPO,
    "--json", "number,title,body,labels,author,createdAt,url,comments",
  ], { encoding: "utf-8", env: { ...process.env, GH_TOKEN } });
  const issue = JSON.parse(out);
  // Mark the issue as freshly fetched so the downstream enqueueIssue does
  // NOT issue a second `gh issue view` for the same number.
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name),
    author: issue.author?.login || issue.author || "unknown",
    url: issue.url || "",
    createdAt: issue.createdAt || "",
    comments: normalizeIssueComments(issue.comments),
    _fresh: true,
  };
}

function acquireDaemonLock() {
  const file = path.join(STATE_DIR, "daemon.pid");
  const record = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fsSync.writeFileSync(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      return { file, pid: process.pid };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let live = false;
      try {
        const existing = JSON.parse(fsSync.readFileSync(file, "utf8"));
        process.kill(existing.pid, 0);
        live = true;
      } catch (probe) {
        live = probe?.code === "EPERM";
      }
      if (live) throw new Error(`Another factory daemon owns ${file}`);
      try { fsSync.unlinkSync(file); } catch {}
    }
  }
  throw new Error(`Cannot acquire daemon lock ${file}`);
}

function releaseDaemonLock(lock) {
  try {
    const current = JSON.parse(fsSync.readFileSync(lock.file, "utf8"));
    if (current.pid === lock.pid) fsSync.unlinkSync(lock.file);
  } catch {}
}

async function readCheckpoint(number) {
  try {
    return JSON.parse(await fs.readFile(path.join(STATE_DIR, 'issues', `${number}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Process one issue end-to-end. Sets up a fresh workdir (clone of target
 * repo), invokes the factory CLI, and persists the outcome as state.
 */
async function processIssue(issue, stage = "") {
  const startedAt = new Date().toISOString();
  const issuePath = issue._issuePath || path.join(STATE_DIR, `issue-${issue.number}.json`);
  // Refresh issue JSON on disk for the CLI.
  await fs.writeFile(issuePath, JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: issue.labels || [],
    author: typeof issue.author === "string" ? issue.author : (issue.author?.login || "unknown"),
    url: issue.url || "",
    createdAt: issue.createdAt || new Date().toISOString(),
    comments: issue.comments || [],
  }, null, 2));

  // Fresh git workdir per issue so concurrent runs don't collide.
  const issueWorkdir = path.join(WORKDIR, `issue-${issue.number}-${Date.now()}`);
  fsSync.mkdirSync(issueWorkdir, { recursive: true });
  const sourceRoot = fsSync.existsSync(path.join(factoryRoot, "factory", "src"))
    ? path.join(factoryRoot, "factory")
    : factoryRoot;
  let defaultBranch = process.env.FACTORY_DEFAULT_BRANCH || "main";
  const userSetDefaultBranch = Boolean(process.env.FACTORY_DEFAULT_BRANCH);

  if (FACTORY_GH_REPO && GH_TOKEN) {
    // Clone the target repo so commit_and_push has somewhere to push.
    log("INFO", "cloning-target-repo", { issue: issue.number, repo: FACTORY_GH_REPO, dst: issueWorkdir });
    try {
      execFileSync("gh", ["repo", "clone", FACTORY_GH_REPO, issueWorkdir], {
        stdio: "ignore",
        env: { ...process.env, GH_TOKEN },
      });
      try {
        const remoteHead = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
          cwd: issueWorkdir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const detected = remoteHead.replace(/^origin\//, "");
        // Auto-detected branch is a hint, not a mandate. Only override when
        // the operator did NOT pass FACTORY_DEFAULT_BRANCH explicitly.
        if (!userSetDefaultBranch && detected) defaultBranch = detected;
      } catch {
        try {
          const detected = execFileSync("git", ["branch", "--show-current"], {
            cwd: issueWorkdir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (!userSetDefaultBranch && detected) defaultBranch = detected;
        } catch {}
      }
      log("INFO", "clone-done", { issue: issue.number, dst: issueWorkdir });
      // If the target repo is empty (no commits yet), `git diff HEAD`
      // will fail later in the implementation agent. Seed an initial
      // commit on the default branch AND push it so origin/main exists —
      // PRs target main, and `gh pr create` rejects "Base ref must be a
      // branch" if origin's default branch is missing.
      try {
        execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: issueWorkdir, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        try {
          execFileSync("git", ["checkout", "-b", defaultBranch], { cwd: issueWorkdir, stdio: "ignore" });
        } catch {}
        try {
          execFileSync("git", ["add", "-A"], { cwd: issueWorkdir, stdio: "ignore" });
          execFileSync("git", ["-c", "user.email=factory@local", "-c", "user.name=local-factory", "commit", "--allow-empty", "-m", "Initial commit"], { cwd: issueWorkdir, stdio: "ignore" });
          try {
            execFileSync("git", ["push", "-u", "origin", defaultBranch], { cwd: issueWorkdir, stdio: "ignore", env: { ...process.env, GH_TOKEN } });
            log("INFO", "seeded-initial-commit", { issue: issue.number, branch: defaultBranch, pushed: true });
          } catch (pushErr) {
            log("WARN", "seed-initial-commit-push-failed", { issue: issue.number, branch: defaultBranch, error: String(pushErr).split("\n")[0] });
          }
        } catch (seedErr) {
          log("WARN", "seed-initial-commit-failed", { issue: issue.number, error: String(seedErr).split("\n")[0] });
        }
      }
    } catch (err) {
      log("ERROR", "clone-failed", { issue: issue.number, error: String(err) });
      await releaseIssueClaim(issue, false);
      return { ok: false, error: "clone failed" };
    }
  }

  // The local daemon is the trusted worker: it already has your LLM
  // credentials, your GitHub token, and full filesystem access under the
  // configured workdir. The FACTORY_TRUSTED_EXECUTION gate in tools.ts
  // exists to keep a CI runner safe; for the local daemon the operator
  // is opting in by running the daemon in the first place, so we
  // default it on. Set FACTORY_TRUSTED_EXECUTION=0 in your .env to
  // re-enable the strict CI-style gate.
  const FACTORY_TRUSTED_EXECUTION = process.env.FACTORY_TRUSTED_EXECUTION || "1";

  // Local-inbox mode has no real GitHub issue to sync against — disable
  // label/comment sync so the pipeline doesn't hit `gh issue view` for a
  // synthetic number. Operator can still force-sync by exporting
  // FACTORY_SYNC_LABELS=1 explicitly before launching the daemon.
  const FACTORY_SYNC_LABELS = process.env.FACTORY_SYNC_LABELS ?? (LOCAL_DIR ? "0" : "");

  // Spec / Implementation agents emit multi-KB bodies. The default
  // Anthropic `max_tokens` (4096) truncates mid-string and leaves the
  // pipeline unable to parse the JSON. Raise it for the local daemon
  // unless the operator has already set their own preference.
  const ANTHROPIC_MAX_TOKENS = process.env.ANTHROPIC_MAX_TOKENS || "16384";

  const env = {
    ...process.env,
    FACTORY_AGENT_MODE: AGENT_MODE, // legacy; factory runs in llm mode only
    FACTORY_DEFAULT_BRANCH: defaultBranch,
    FACTORY_STATE_DIR: STATE_DIR,
    FACTORY_REMOTE_PATH: FACTORY_GH_REPO ? `https://github.com/${FACTORY_GH_REPO}.git` : "",
    FACTORY_GH_REPO,
    GH_TOKEN,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    ANTHROPIC_MAX_TOKENS,
    FACTORY_TRUSTED_EXECUTION,
    FACTORY_SYNC_LABELS,
  };

  // Pipeline runner: prefer the bundled orchestrator that ships in
  // this package's dist/ (no tsx, no source copy). A development checkout
  // may run its source in place, while keeping the target workdir clean.
  const bundlePath = path.join(factoryRoot, "dist", "factory", "run-issue.js");
  const cliPath = path.join(sourceRoot, "src", "cli", "run-issue.ts");
  const tsxCandidates = [
    path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(factoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const tsxCli = tsxCandidates.find((p) => fsSync.existsSync(p)) || tsxCandidates[0];

  const runner = process.execPath;
  let runnerArgs;
  if (fsSync.existsSync(bundlePath)) {
    runnerArgs = [bundlePath];
    log("INFO", "starting-pipeline", { issue: issue.number, runner: "bundle", file: bundlePath });
  } else if (fsSync.existsSync(cliPath)) {
    runnerArgs = [tsxCli, cliPath];
    log("INFO", "starting-pipeline", { issue: issue.number, runner: "tsx", file: cliPath, tsx: tsxCli });
  } else {
    log("ERROR", "no-pipeline-runner", { bundlePath, cliPath, factoryRoot });
    await releaseIssueClaim(issue, false);
    return null;
  }

  let stdout = "", stderr = "";
  const exitCode = await new Promise((resolve) => {
    const childArgs = [
      ...runnerArgs,
      "--issue", issuePath,
    ];
    if (stage) childArgs.push("--stage", stage);
    const child = spawn(runner, childArgs, { cwd: issueWorkdir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== 'win32' });
    const append = (current, chunk) => (current + chunk).slice(-MAX_CHILD_OUTPUT);
    child.stdout.on("data", (b) => stdout = append(stdout, b));
    child.stderr.on("data", (b) => stderr = append(stderr, b));
    const timeout = setTimeout(() => {
      stderr = append(stderr, `\npipeline exceeded ${RUN_TIMEOUT_MS}ms and was terminated\n`);
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      }
    }, RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      stderr += `failed to start pipeline: ${String(error)}\n`;
      resolve(1);
    });
    // Wait for the pipes to drain before parsing stdout or persisting stderr.
    child.on("close", (code, signal) => { clearTimeout(timeout); resolve(code ?? (signal ? 1 : 0)); });
  });

  let summary = {};
  try { summary = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch {}
  const pipeline = stage
    ? { executionOk: exitCode === 0, completed: exitCode === 0, outcome: exitCode === 0 ? "completed" : "failed" }
    : classifyPipelineOutcome(exitCode, summary);

  const stateRecord = {
    number: issue.number,
    title: issue.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    outcome: pipeline.outcome,
    completed: pipeline.completed,
    workdir: issueWorkdir,
    summary,
    stdout: stdout.slice(-16_000),
    stderr: stderr.slice(-16_000),
  };
  const stateName = stage ? `state-${stage}.json` : `state-${issue.number}.json`;
  fsSync.writeFileSync(path.join(STATE_DIR, stateName), JSON.stringify(stateRecord, null, 2));
  if (pipeline.completed) {
    log("INFO", "pipeline-completed", { issue: issue.number, exitCode, summary });
  } else if (pipeline.executionOk) {
    log("WARN", "pipeline-waiting", { issue: issue.number, exitCode, outcome: pipeline.outcome, summary });
  } else {
    log("ERROR", "pipeline-failed", { issue: issue.number, exitCode, summary, stderr: stderr.slice(-4_000) });
  }

  // Release the transient claim after every run. Durable checkpoints and
  // the current GitHub state determine whether a later poll should resume.
  if (!stage) {
    await releaseIssueClaim(issue, exitCode === 0);
    const verdict = summary?.review?.verdict;
    if (verdict === "REJECT") {
      log("WARN", "issue-rejected-will-retry", {
        issue: issue.number,
        comments: summary?.review?.comments ?? null,
        branch: summary?.implementation?.branch ?? null,
      });
    }
  }
  return { ok: pipeline.executionOk, completed: pipeline.completed, outcome: pipeline.outcome, summary, stdout, stderr };
}

let issueQueue = Promise.resolve();
function enqueueIssue(issue, stage = "") {
  const run = issueQueue.then(async () => {
    // Only refresh from GitHub when:
    //   - the caller didn't already fetch (issue._fresh flag), AND
    //   - the issue did NOT come from a local inbox pickup (issue._sourceFile), AND
    //   - we have GitHub credentials, AND
    //   - the caller is requesting the full pipeline (not a sub-stage), AND
    //   - this is a real GitHub issue (number > 0).
    // Otherwise we'd hit the API twice per webhook delivery, and worse,
    // a local-inbox issue whose number happens to match a real GitHub
    // issue would silently be replaced by the GitHub content.
    const isLocalPickup = Boolean(issue._sourceFile);
    const needsRefresh = !issue._fresh
      && !isLocalPickup
      && !stage
      && FACTORY_GH_REPO
      && GH_TOKEN
      && Number(issue.number) > 0;
    const currentIssue = needsRefresh ? await fetchIssueFromGitHub(issue.number) : issue;
    return processIssue(currentIssue, stage);
  });
  issueQueue = run.catch(() => {});
  return run;
}

async function releaseIssueClaim(issue, succeeded) {
  try { fsSync.unlinkSync(path.join(STATE_DIR, `fetched-${issue.number}`)); } catch {}
  if (!issue._sourceFile || !issue._sourceName) return;
  const destination = succeeded ? path.join(LOCAL_DIR, '.processed', issue._sourceName) : path.join(LOCAL_DIR, issue._sourceName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(issue._sourceFile, destination).catch(() => {});
}

async function maybeRunDailyImprovement(force = false) {
  const marker = path.join(STATE_DIR, "last-improve-review-pr");
  try {
    const lastRun = Date.parse(fsSync.readFileSync(marker, "utf-8").trim());
    if (!force && Number.isFinite(lastRun) && Date.now() - lastRun < 24 * 60 * 60 * 1000) {
      return { ok: true, skipped: true };
    }
  } catch {}

  const result = await enqueueIssue({
    number: 0,
    title: "Daily review feedback improvement",
    body: "Inspect merged pull-request feedback from the last 24 hours and update review-pr only when a durable learning exists.",
    labels: [],
    author: "factory-daemon",
    url: "",
    createdAt: new Date().toISOString(),
  }, "improve-review-pr");
  if (result?.ok) fsSync.writeFileSync(marker, new Date().toISOString());
  return result;
}

// === Polling loop ===
async function pollingLoop() {
  log("INFO", "daemon-start", {
    repo: FACTORY_GH_REPO || "(local)",
    interval: POLL_INTERVAL,
    localDir: LOCAL_DIR,
    once: args.once === true,
    agentMode: AGENT_MODE,
    llmBaseUrl: ANTHROPIC_BASE_URL || "(unset)",
    llmModel: ANTHROPIC_MODEL || "(unset)",
  });
  while (true) {
    try {
      // Run the daily improvement check on every loop tick — the function
      // itself short-circuits when its 24h cooldown hasn't elapsed, so an
      // always-busy issue queue never starves the review feedback loop.
      await maybeRunDailyImprovement();
      const issue = await fetchNextIssue();
      if (issue) {
        log("INFO", "process-issue-start", { issue: issue.number });
        try {
          const result = await enqueueIssue(issue);
          // Surface the review verdict so REJECT is visible in daemon.log
          // (not masked by exitCode===0). The CLI's stdout ends with a
          // JSON summary; `summary.review.comments` is the count (number),
          // not an array — see src/cli/run-issue.ts:90.
          const review = result?.summary?.review ?? null;
          const verdict = review?.verdict ?? null;
          const comments = typeof review?.comments === "number" ? review.comments : null;
          const merged = Boolean(result?.summary?.merged);
          const level = !result?.ok ? "ERROR" : result?.completed ? "INFO" : "WARN";
          log(level, "process-issue-end", {
            issue: issue.number,
            ok: result?.ok,
            completed: result?.completed,
            outcome: result?.outcome,
            status: result?.summary?.status ?? null,
            nextLabel: result?.summary?.nextLabel ?? null,
            verify: result?.summary?.verify ?? null,
            verdict,
            comments,
            merged,
          });
          if (args.once) return result?.ok ? 0 : 1;
          if (!result?.ok) await sleep(POLL_INTERVAL * 1000);
        } catch (inner) {
          log("ERROR", "process-issue-failed", {
            issue: issue.number,
            error: String(inner),
            stack: inner?.stack ? String(inner.stack).split("\n").slice(0, 5).join(" | ") : null,
          });
          // Drop the in-flight marker so the next poll retries. Don't write
          // the permanent processed-N marker.
          try { fsSync.unlinkSync(path.join(STATE_DIR, `fetched-${issue.number}`)); } catch {}
          if (args.once) return 1;
          await sleep(POLL_INTERVAL * 1000);
        }
      } else {
        if (args.once) return 0;
        await sleep(POLL_INTERVAL * 1000);
      }
    } catch (err) {
      log("ERROR", "loop-error", { error: String(err) });
      if (args.once) return 1;
      await sleep(POLL_INTERVAL * 1000);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Belt + suspenders. processIssue does multiple await execFileSync calls
// and remote ops that can throw; without these handlers the daemon would
// silently exit on unhandled rejections (especially under Windows where
// the worker thread exits before its log buffer flushes).
process.on("unhandledRejection", (reason) => {
  try { log("ERROR", "unhandled-rejection", { error: String(reason) }); } catch {}
  process.exitCode = 1;
});
process.on("uncaughtException", (err) => {
  try { log("ERROR", "uncaught-exception", { error: String(err) }); } catch {}
  process.exitCode = 1;
});

// === Webhook server ===
async function startWebhookServer() {
  if (!WEBHOOK_PORT) return;
  if (!WEBHOOK_SECRET) throw new Error("FACTORY_WEBHOOK_SECRET is required when webhook mode is enabled");
  if (!FACTORY_GH_REPO || !GH_TOKEN) throw new Error("FACTORY_GH_REPO and GH_TOKEN are required when webhook mode is enabled");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/webhook")) {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (Buffer.byteLength(body) > 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const signature = String(req.headers["x-hub-signature-256"] || "");
        const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
        if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          res.writeHead(401); res.end(); return;
        }
        const delivery = String(req.headers["x-github-delivery"] || "");
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(delivery)) { res.writeHead(400); res.end(); return; }
        const deliveryFile = path.join(STATE_DIR, `delivery-${delivery}`);
        try { fsSync.writeFileSync(deliveryFile, new Date().toISOString(), { flag: "wx" }); }
        catch { res.writeHead(202); res.end(JSON.stringify({ ok: true, duplicate: true })); return; }
        const event = req.headers["x-github-event"];
        const payload = JSON.parse(body || "{}");
        const userComment = event === "issue_comment" && payload.action === "created" && payload.comment?.user?.type === "User";
        if ((event === "issues" && ["opened", "edited", "labeled", "unlabeled"].includes(payload.action)) || userComment) {
          const issueNumber = Number(payload.issue?.number);
          if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error("Webhook payload has no valid issue number");
          log("INFO", "webhook-issue-queued", { number: issueNumber, event });
          void fetchIssueFromGitHub(issueNumber)
            .then((issue) => enqueueIssue(issue))
            .catch((error) => log("ERROR", "webhook-pipeline-failed", { issue: issueNumber, error: String(error) }));
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log("ERROR", "webhook-error", { error: String(err) });
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.listen(WEBHOOK_PORT, () => {
    log("INFO", "webhook-listening", { port: WEBHOOK_PORT });
  });
}

// === Main ===
(async () => {
  if (!GH_TOKEN) log("WARN", "no-gh-token", {});
  if (!ANTHROPIC_AUTH_TOKEN) log("WARN", "no-anthropic-token", {});
  if (AGENT_MODE === "llm" && !LLM_CONFIGURED) throw new Error("Real agent mode requires ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and ANTHROPIC_MODEL");

  // Sweep transient fetched-* markers left by a prior crashed daemon.
  let cleared = 0;
  try {
    const entries = fsSync.readdirSync(STATE_DIR);
    for (const name of entries) {
      if (!name.startsWith("fetched-")) continue;
      // Only consider fetched-* whose daemon mtime doesn't match a
      // running process; simplest heuristic: drop the marker entirely
      // on a fresh start. processIssue will re-create it immediately.
      try { fsSync.unlinkSync(path.join(STATE_DIR, name)); cleared++; } catch {}
    }
  } catch {}
  if (cleared > 0) log("INFO", "cleared-stale-fetched-markers", { cleared });

  if (args.daily) {
    const result = await maybeRunDailyImprovement(true);
    process.exitCode = result?.ok ? 0 : 1;
    return;
  }

  if (WEBHOOK_PORT) await startWebhookServer();
  const exitCode = await pollingLoop();
  if (args.once) process.exitCode = exitCode;
})();
