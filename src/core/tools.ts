import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentContext } from "./types.js";
import type { AgentTool } from "./agent.js";
import { commitAndPush, openPullRequest } from "../github/git.js";

const exec = promisify(execFile);

export function readOnlyTools(ctx: AgentContext): AgentTool[] {
  return defaultTools(ctx).filter((tool) => ['read_file', 'list_dir', 'grep_repo', 'fetch_issue'].includes(tool.name));
}

async function confinedPath(root: string, rel: string): Promise<string> {
  const base = await fs.realpath(root);
  const candidate = path.resolve(base, rel);
  const inside = (value: string) => { const p = path.relative(base, value); return p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p); };
  if (!inside(candidate)) throw new Error('Path escapes repository');
  let ancestor = candidate;
  for (;;) {
    try {
      if (!inside(await fs.realpath(ancestor))) throw new Error('Symlink escapes repository');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return candidate;
}

function assertSafeReadPath(rel: string): void {
  const normalized = rel.replace(/\\/g, '/');
  const segments = normalized.toLowerCase().split('/').filter(Boolean);
  if (segments.some((segment) => ['.git', '.factory', '.factory-daemon'].includes(segment))) throw new Error('Protected repository metadata cannot be read by an agent');
  const name = segments.at(-1) ?? '';
  const safeExample = /^\.env\.(?:example|sample|template)$/.test(name);
  if ((!safeExample && /^\.env(?:\..+)?$/.test(name)) || ['.npmrc', '.pypirc', '.netrc'].includes(name)) throw new Error('Potential credential file cannot be read by an agent');
}

/**
 * The tool registry shared by every agent.
 *
 * Concrete agents register only the tools they actually need via the BaseAgent
 * `tools_` constructor argument. The tools below are the same primitives a
 * developer would use: read a file, write a file, run a shell command, grep
 * the repo, search the issue tracker.
 */
export function defaultTools(ctx: AgentContext): AgentTool[] {
  return [
    readFileTool(ctx),
    writeFileTool(ctx),
    listDirTool(ctx),
    runShellTool(ctx),
    grepTool(ctx),
    fetchIssueTool(ctx),
    postIssueCommentTool(ctx),
    updateIssueLabelsTool(ctx),
  ];
}

/** Reads a file under the repo working directory. Returns empty string + flag when missing. */
function readFileTool(ctx: AgentContext): AgentTool {
  return {
    name: "read_file",
    description: "Read a UTF-8 file from the repository. Args: { path: string }",
    async execute(args, c) {
      const rel = String(args.path ?? "");
      assertSafeReadPath(rel);
      const abs = await confinedPath(c.repo.workdir, rel);
      try {
        const body = await fs.readFile(abs, "utf-8");
        return { content: body, exists: true, path: rel };
      } catch (err: unknown) {
        return { content: "", exists: false, path: rel, error: String((err as Error).message ?? err) };
      }
    },
  };
}

/** Writes a file under the repo working directory. */
function writeFileTool(ctx: AgentContext): AgentTool {
  return {
    name: "write_file",
    description: "Write a UTF-8 file. Args: { path: string, content: string }",
    async execute(args, c) {
      const rel = String(args.path ?? "");
      const abs = await confinedPath(c.repo.workdir, rel);
      const normalized = path.relative(c.repo.workdir, abs);
      if (/^(?:\.git|\.factory|\.factory-daemon)(?:[\\/]|$)/.test(normalized)) throw new Error('Protected factory or git path');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content ?? ""), "utf-8");
      return { written: rel, bytes: Buffer.byteLength(String(args.content ?? ""), "utf-8") };
    },
  };
}

/** Lists directory entries (relative to repo working dir). Returns empty list when missing. */
function listDirTool(ctx: AgentContext): AgentTool {
  return {
    name: "list_dir",
    description: "List entries under a directory. Args: { path: string }",
    async execute(args, c) {
      const rel = String(args.path ?? ".");
      const abs = await confinedPath(c.repo.workdir, rel);
      try {
        const entries = await fs.readdir(abs, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      } catch (err: unknown) {
        return [];
      }
    },
  };
}

/** Runs a shell command in the repo working dir. Returns stdout/stderr/exit. */
function runShellTool(ctx: AgentContext): AgentTool {
  return {
    name: "run_shell",
    description: "Run a shell command. Args: { command: string, cwd?: string, timeoutMs?: number }",
    async execute(args, c) {
      const cmd = String(args.command ?? "");
      if (process.env.FACTORY_TRUSTED_EXECUTION !== '1') throw new Error('Shell execution requires FACTORY_TRUSTED_EXECUTION=1 on an isolated trusted worker');
      assertSafeAgentCommand(cmd);
      const cwd = await confinedPath(c.repo.workdir, String(args.cwd ?? '.'));
      const requested = Number(args.timeoutMs ?? 120_000);
      const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 120000) : 120000;
      const env = { ...process.env };
      // Strip secrets (broad) and FACTORY_* secrets (narrow). Other FACTORY_*
      // variables — FACTORY_VERIFY_URL, FACTORY_VERIFY_COMMAND,
      // FACTORY_DEFAULT_BRANCH, FACTORY_GH_REPO, FACTORY_REMOTE_PATH, etc.
      // — are configuration, not credentials, and must be visible to
      // validation scripts and shell-based regression checks.
      for (const key of Object.keys(env)) {
        if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)) delete env[key];
        else if (/^FACTORY_(API_KEY|AUTH_TOKEN|SECRET|PASSWORD|TOKEN)/i.test(key)) delete env[key];
      }
      try {
        const shell = process.platform === "win32" ? "powershell.exe" : "bash";
        const shellArgs = process.platform === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", cmd]
          : ["-lc", cmd];
        const { stdout, stderr } = await exec(shell, shellArgs, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(err),
          exitCode: typeof e.code === "number" ? e.code : 1,
        };
      }
    },
  };
}

/** Greps the repo for a regex and returns matching lines. */
function grepTool(ctx: AgentContext): AgentTool {
  return {
    name: "grep_repo",
    description: "Grep files for a regex. Args: { pattern: string, glob?: string, max?: number }",
    async execute(args, c) {
      const pattern = String(args.pattern ?? "");
      const glob = args.glob ? String(args.glob) : "*";
      const max = Number(args.max ?? 50);
      try {
        const { stdout } = await exec("rg", ["-n", "--glob", glob, "--", pattern, c.repo.workdir], {
          maxBuffer: 4 * 1024 * 1024,
        });
        const lines = stdout.split("\n").filter(Boolean);
        return { matches: lines.slice(0, max), total: lines.length };
      } catch (err: unknown) {
        const e = err as { stdout?: string; code?: number };
        if (e.code !== 1) throw err;
        const lines = (e.stdout ?? "").split("\n").filter(Boolean);
        return { matches: lines.slice(0, max), total: lines.length };
      }
    },
  };
}

/** Fetches issue context from the configured tracker (here a local fixture). */
function fetchIssueTool(ctx: AgentContext): AgentTool {
  return {
    name: "fetch_issue",
    description: "Fetch full issue context. Args: { issueNumber: number }",
    async execute(args, c) {
      // The orchestrator passes the issue via ctx; this tool just returns it.
      return { issue: c.issue };
    },
  };
}

/** Posts a comment on the issue when GitHub is configured. */
function postIssueCommentTool(ctx: AgentContext): AgentTool {
  return {
    name: "post_issue_comment",
    description: "Post a markdown comment on the issue. Args: { body: string }",
    async execute(args, c) {
      const body = String(args.body ?? "");
      const repo = process.env.FACTORY_GH_REPO;
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      if (!repo || !token) throw new Error('GitHub repository and token are required to post an issue comment');
      if (body) {
        await exec("gh", ["issue", "comment", String(c.issue.number), "--repo", repo, "--body", body], {
          env: { ...process.env, GH_TOKEN: token },
        });
      }
      c.logger.info(`[post_issue_comment] #${c.issue.number} bytes=${body.length}`);
      return { posted: true, body, issueNumber: c.issue.number };
    },
  };
}

/** Adds or removes labels on the issue when GitHub is configured. */
function updateIssueLabelsTool(ctx: AgentContext): AgentTool {
  return {
    name: "update_issue_labels",
    description: "Add or remove labels. Args: { add?: string[], remove?: string[] }",
    async execute(args, c) {
      const add = Array.isArray(args.add) ? (args.add as string[]) : [];
      const remove = Array.isArray(args.remove) ? (args.remove as string[]) : [];
      const repo = process.env.FACTORY_GH_REPO;
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      if (!repo || !token) throw new Error('GitHub repository and token are required to update issue labels');
      const env = { ...process.env, GH_TOKEN: token };
      for (const label of add) {
        await exec("gh", ["label", "create", label, "--repo", repo, "--color", "5319E7", "--force"], { env });
        await exec("gh", ["issue", "edit", String(c.issue.number), "--repo", repo, "--add-label", label], { env });
      }
      for (const label of remove) {
        try {
          await exec("gh", ["issue", "edit", String(c.issue.number), "--repo", repo, "--remove-label", label], { env });
        } catch {
          // Removing a label that is not present is harmless.
        }
      }
      c.logger.info(`[update_issue_labels] add=${add.join(",")} remove=${remove.join(",")}`);
      return { added: add, removed: remove };
    },
  };
}

/** Commit changes on a feature branch and push to origin. */
export function commitAndPushTool(ctx: AgentContext): AgentTool {
  return {
    name: "commit_and_push",
    description: "Commit the working tree on a new branch and push to origin. Args: { branch: string, message: string, files?: string[] }",
    async execute(args, c) {
      const branch = String(args.branch ?? "feature/auto");
      const message = String(args.message ?? "factory commit");
      const files = Array.isArray(args.files) ? (args.files as string[]) : undefined;
      const result = await commitAndPush({ workdir: c.repo.workdir, branch, message, files });
      return result;
    },
  };
}

/** Open a pull request against the configured base branch. Real git push to refs/pull/. */
export function openPullRequestTool(ctx: AgentContext, remotePath: string): AgentTool {
  return {
    name: "open_pull_request",
    description: "Open a pull request. Args: { branch: string, baseBranch?: string, title: string, body: string }",
    async execute(args, c) {
      const branch = String(args.branch ?? "main");
      const baseBranch = String(args.baseBranch ?? c.repo.defaultBranch ?? "main");
      const title = String(args.title ?? "");
      const body = String(args.body ?? "");
      const result = await openPullRequest({
        workdir: c.repo.workdir,
        remotePath,
        branch,
        baseBranch,
        title,
        body,
      });
      return result;
    },
  };
}

/**
 * Capability-based command allow-list for LLM-issued shell commands.
 *
 * The factory runs in `llm` mode only, so every command issued by an agent
 * goes through this gate. The checks are layered: any one of them rejecting
 * the command is enough to abort.
 *
 *  1. Path protection: never let the agent touch `.git`, `.factory*`, or
 *     credential files.
 *  2. Shell metacharacter ban — pipe / redirect / command substitution /
 *     `${IFS}` are forbidden. Use a typed tool (`write_file`,
 *     `commit_and_push`, `fetch_issue`) instead.
 *  3. Network-download ban — `curl`/`wget`/PowerShell `iwr`/`irm` are
 *     never allowed; if the agent needs external data it must use the
 *     typed `fetch_issue` tool or be granted credentials explicitly.
 *  4. Interpreter invocation ban — `sh`/`bash`/`pwsh`/`powershell`/`cmd`
 *     would let the agent bypass checks 2 and 3 entirely.
 *  5. VCS write ban — `git`/`gh` write verbs must go through
 *     `commit_and_push` and `update_issue_labels`.
 *  6. Destructive FS ban — `rm -rf` and PowerShell deletes.
 *  7. Publishing ban — `npm publish` etc. are reserved for release tooling.
 */
export function assertSafeAgentCommand(command: string): void {
  if (!command.trim()) throw new Error('Agent command must be non-empty');
  if (/[\r\n]/.test(command)) throw new Error('Agent command must be a single non-empty line');

  // 1. Path protection
  if (/(?:^|[\s;&|])(?:\.factory-daemon|\.factory|\.git)(?:[\\/\s|&;]|$)|(?:^|[\s;&|])(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc)(?:[\s;&|]|$)/i.test(command)) {
    throw new Error('Agent command references protected metadata or a potential credential file');
  }

  // 2. Shell metacharacter ban (catches pipe, redirect, command substitution,
  //    and `${IFS}` whitespace substitution in one sweep)
  if (/[|&]|[<>]|\$\(|\$\{|`[^`]*`|\$\{IFS\}/.test(command)) {
    throw new Error('Agent command uses shell metacharacter (pipe / redirect / command substitution); use a typed tool instead');
  }

  // 3. Network download — covers both POSIX (`curl`/`wget`) and PowerShell
  //    aliases (`iwr`, `irm`, `Invoke-WebRequest`).
  if (/(?:^|[\s;&|])(?:curl|wget|iwr|irm|Invoke-WebRequest|DownloadFile|fetch\s+)\b/i.test(command)) {
    throw new Error('Network download from agent is not allowed; use the typed fetch_issue tool');
  }

  // 4. Shell interpreter invocation — would let the agent bypass the
  //    metacharacter ban via `bash -c "..."`.
  if (/(?:^|[\s;&|])(?:sh|bash|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|iex|Invoke-Expression)\b/i.test(command)) {
    throw new Error('Shell interpreter invocation is not allowed from agent');
  }

  // 5. VCS write — the agent must use the typed `commit_and_push` and
  //    `update_issue_labels` tools so the orchestrator can audit + undo.
  if (/(?:^|[\s;&|])(?:git\s+(?:push|commit|reset|clean|checkout|switch|merge|rebase|tag)|gh\s+(?:issue|pr|release|repo)\s+(?:create|edit|close|merge|delete))\b/i.test(command)) {
    throw new Error('VCS write operations require the typed commit_and_push tool');
  }

  // 6. Destructive filesystem operations
  if (/(?:^|[\s;&|])(?:rm\s+-[rf]|Remove-Item|del\s+\/[sq]|ri\s+|rd\s+|mkfs|dd\s+)/i.test(command)) {
    throw new Error('Destructive filesystem operations are not allowed');
  }

  // 7. Publishing
  if (/(?:^|[\s;&|])(?:npm\s+publish|pip\s+install\s+--upgrade|cargo\s+publish)\b/i.test(command)) {
    throw new Error('Publishing from agent is not allowed');
  }
}
