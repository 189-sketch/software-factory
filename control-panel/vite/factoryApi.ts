/**
 * factoryApi — a Vite plugin that exposes the factory's real runtime state
 * to the control panel over HTTP. All endpoints read from disk under the
 * process's cwd (the factory repo root). When a file is missing, the
 * endpoint returns an honest empty result rather than a placeholder.
 *
 * Endpoints:
 *   GET /api/projects                   → list of configured projects
 *   GET /api/projects/:id              → single project + recent issues
 *   GET /api/projects/:id/issues       → all issues (state files + fixtures)
 *   GET /api/events                    → daemon log tail (parsed JSON lines)
 *   GET /api/agents                    → agents with live SKILL.md content
 *   GET /api/settings                  → env-derived runtime config
 *
 * The plugin keeps no in-memory state of its own; it reads on every
 * request. This matches the factory's own model — every state file is the
 * source of truth, and the panel is just a projection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import type { Plugin, ViteDevServer } from "vite";

type IssueState = Record<string, unknown>;
type IssueFixture = Record<string, unknown>;
type ProjectMeta = {
    id: string;
    name: string;
    repo: string;
    defaultBranch: string;
    isCurrent: boolean;
};

type ProjectMetrics = {
    /** Issues merged in the last 7 days (passed merge stage, ended in window). */
    merged7d: number;
    /** Issues rejected at review stage in the last 30 days. */
    rejected30d: number;
    /** Total reviews with verdict=APPROVE in the last 30 days. */
    approved30d: number;
    /** Average ms from triage start to merge end across all merged issues. */
    avgTimeToMergeMs: number | null;
    /** Issues that started a stage in the last 24h. */
    started24h: number;
    /** Issues that finished a stage (passed/skip) in the last 24h. */
    closed24h: number;
};
type AgentEntry = {
    id: string;
    label: string;
    skillPath: string;
    skillBody: string;
    description: string;
    stage: string;
    tags: string[];
    mode: 'llm';
    model: string;
    enabled: boolean;
};
type EventEntry = {
    id: string;
    ts: string;
    level: "INFO" | "WARN" | "ERROR";
    stage: string;
    projectId: string;
    message: string;
    bindings: Record<string, unknown>;
};
type SettingsPayload = {
    baseUrl: string;
    defaultModel: string;
    pollIntervalSec: number;
    localDaemon: { active: boolean; pid: number | null; uptimeSec: number; workdir: string };
};

const STATE_DIR = ".factory/issues";
const FIXTURE_DIR = "fixtures/issues";
const SKILLS_DIR = "skills";
const DAEMON_LOG = ".factory/daemon.log";
const DAEMON_ENV = ".factory-daemon/.env";

const STAGE_OF_DIR = (dir: string): { stage: string; label: string } | null => {
    const map: Record<string, { stage: string; label: string }> = {
        "triage": { stage: "triage", label: "Triage" },
        "spec": { stage: "spec", label: "Spec" },
        "implementation": { stage: "implementation", label: "Implementation" },
        "review-pr": { stage: "review", label: "Review PR" },
        "verify-behavior": { stage: "verify", label: "Verify Behavior" },
        "improve-review-pr": { stage: "improve", label: "Improve Review PR" },
    };
    return map[dir] ?? null;
};

async function safeReadText(p: string): Promise<string | null> {
    try {
        return await fs.readFile(p, "utf-8");
    } catch {
        return null;
    }
}

async function safeReadJson<T>(p: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(p, "utf-8")) as T;
    } catch {
        return null;
    }
}

async function listDirSafe(p: string): Promise<string[]> {
    try {
        return await fs.readdir(p);
    } catch {
        return [];
    }
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

async function readProjects(
    root: string,
): Promise<{ projects: ProjectMeta[]; metrics: Record<string, ProjectMetrics> }> {
    const projects: ProjectMeta[] = [];

    // The current repo is always a project we can show.
    const pkg = await safeReadJson<{ name?: string; repository?: string | { url?: string } }>(
        path.join(root, "package.json"),
    );
    const envText = await safeReadText(path.join(root, DAEMON_ENV));
    const configuredRepo = envText?.match(/FACTORY_GH_REPO\s*=\s*([^\s#]+)/)?.[1]?.trim();
    const repoFromPkg = (() => {
        if (configuredRepo) return configuredRepo;
        if (!pkg?.repository) return "unconfigured";
        if (typeof pkg.repository === "string") return pkg.repository;
        return pkg.repository.url ?? "189-sketch/software-factory";
    })();
    // Prefer the directory basename over the npm package name — for a
    // control panel, the repo name is what users recognize.
    const dirName = path.basename(root);
    projects.push({
        id: "current",
        name: dirName,
        repo: repoFromPkg,
        defaultBranch: "main",
        isCurrent: true,
    });

    // Compute metrics for each project from its persisted state files.
    const metrics: Record<string, ProjectMetrics> = {};
    for (const p of projects) {
        metrics[p.id] = await computeProjectMetrics(root, p.id);
    }

    return { projects, metrics };
}

async function computeProjectMetrics(root: string, projectId: string): Promise<ProjectMetrics> {
    const out: ProjectMetrics = {
        merged7d: 0,
        rejected30d: 0,
        approved30d: 0,
        avgTimeToMergeMs: null,
        started24h: 0,
        closed24h: 0,
    };
    const stateFiles = await listDirSafe(path.join(root, STATE_DIR));
    if (stateFiles.length === 0) return out;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const sevenDayMs = 7 * dayMs;
    const thirtyDayMs = 30 * dayMs;
    const mergeDurations: number[] = [];

    for (const f of stateFiles) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson<{ issue?: { number: number }; triage?: { state?: string }; review?: { verdict?: string } } & IssueState>(
            path.join(root, STATE_DIR, f),
        );
        if (!data) continue;

        const triageStart = findStageStart(data, "triage");
        const mergeEnd = findStageEnd(data, "merge");
        const review = (data as any).review;

        // merged within the last 7 days, with end timestamp inside the window
        if (mergeEnd) {
            const endMs = Date.parse(mergeEnd);
            if (!Number.isNaN(endMs)) {
                if (now - endMs <= sevenDayMs) out.merged7d++;
                if (triageStart) {
                    const startMs = Date.parse(triageStart);
                    if (!Number.isNaN(startMs) && endMs >= startMs) {
                        mergeDurations.push(endMs - startMs);
                    }
                }
            }
        }
        if (review?.verdict === "REJECT" && findStageEnd(data, "review")) {
            const endMs = Date.parse(findStageEnd(data, "review")!);
            if (!Number.isNaN(endMs) && now - endMs <= thirtyDayMs) out.rejected30d++;
        }
        if (review?.verdict === "APPROVE" && findStageEnd(data, "review")) {
            const endMs = Date.parse(findStageEnd(data, "review")!);
            if (!Number.isNaN(endMs) && now - endMs <= thirtyDayMs) out.approved30d++;
        }

        // 24h activity: started / closed counts across all stages of this issue
        for (const st of Object.keys(data)) {
            if (st === "issue" || st === "triage" || st === "spec" || st === "implementation" ||
                st === "review" || st === "verify" || st === "merged") continue;
            // Skip non-stage keys
        }
        const started = findStageStartAll(data);
        const ended = findStageEndAll(data);
        for (const s of started) {
            const ms = Date.parse(s);
            if (!Number.isNaN(ms) && now - ms <= dayMs) out.started24h++;
        }
        for (const s of ended) {
            const ms = Date.parse(s);
            if (!Number.isNaN(ms) && now - ms <= dayMs) out.closed24h++;
        }
    }

    if (mergeDurations.length > 0) {
        out.avgTimeToMergeMs = Math.round(
            mergeDurations.reduce((a, b) => a + b, 0) / mergeDurations.length,
        );
    }

    return out;
}

function findStageStart(state: any, stage: string): string | undefined {
    // StageRecord shape: { startedAt?: string, endedAt?: string, ... }
    const rec = state?.stages?.[stage];
    return rec?.startedAt;
}

function findStageEnd(state: any, stage: string): string | undefined {
    const rec = state?.stages?.[stage];
    return rec?.endedAt;
}

function findStageStartAll(state: any): string[] {
    const out: string[] = [];
    for (const key of ["triage", "spec", "implementation", "review", "verify", "merge"]) {
        const rec = state?.stages?.[key];
        if (rec?.startedAt) out.push(rec.startedAt);
    }
    return out;
}

function findStageEndAll(state: any): string[] {
    const out: string[] = [];
    for (const key of ["triage", "spec", "implementation", "review", "verify", "merge"]) {
        const rec = state?.stages?.[key];
        if (rec?.endedAt) out.push(rec.endedAt);
    }
    return out;
}

async function readIssues(root: string, projectId: string): Promise<unknown[]> {
    const out: unknown[] = [];

    // Live state files (factory has actually processed these). These are
    // the only "real" issues — they came from the GitHub tracker and
    // survived a full triage → spec → implementation cycle.
    const stateFiles = await listDirSafe(path.join(root, STATE_DIR));
    for (const f of stateFiles) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson<{ issue?: { number: number; title: string } } & IssueState>(
            path.join(root, STATE_DIR, f),
        );
        if (!data) continue;
        out.push(data);
    }

    // If the factory daemon has a `gh` token configured, fetch the open
    // issues straight from GitHub. This is the "discovered but not yet
    // processed" list — what an idle factory is waiting for.
    const discovered = await fetchOpenIssuesFromGh(root, projectId);
    for (const i of discovered) out.push(i);

    return out;
}

/**
 * Try to read open issues for the project via the local `gh` CLI.
 * Returns [] when gh is not installed, not authenticated, or fails —
 * the panel is expected to render an honest empty state in that case.
 */
async function fetchOpenIssuesFromGh(root: string, projectId: string): Promise<unknown[]> {
    if (projectId !== "current") return [];
    const repo = await readCurrentRepo(root);
    if (!repo) return [];
    try {
        const { execFile } = await import("node:child_process");
        const { stdout } = await execFileAsync(execFile, "gh", [
            "issue", "list",
            "--repo", repo,
            "--state", "open",
            "--limit", "50",
            "--json", "number,title,body,author,createdAt,url,labels",
        ], { timeout: 5000 });
        const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
        // Mark these as discovered-only (no state) so the panel can
        // distinguish them from processed issues.
        return arr.map((raw) => ({ _discovered: true, issue: raw }));
    } catch {
        return [];
    }
}

async function readCurrentRepo(root: string): Promise<string | null> {
    const pkg = await safeReadJson<{ repository?: string | { url?: string } }>(
        path.join(root, "package.json"),
    );
    const v = pkg?.repository;
    if (!v) return null;
    if (typeof v === "string") return v;
    return v.url ?? null;
}

// Tiny execFile wrapper that doesn't throw on non-zero exit.
function execFileAsync(
    execFile: typeof import("node:child_process").execFile,
    cmd: string,
    args: string[],
    opts: { timeout: number },
): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (err, stdout) => {
            if (err) return reject(err);
            resolve({ stdout });
        });
    });
}

async function readEvents(root: string): Promise<EventEntry[]> {
    const text = await safeReadText(path.join(root, DAEMON_LOG));
    if (!text) return [];
    const out: EventEntry[] = [];
    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const m = raw.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const [, ts, level, stage, rest] = m;
        let message = rest;
        let bindings: Record<string, unknown> = {};
        const braceStart = rest.indexOf("{");
        if (braceStart >= 0) {
            message = rest.slice(0, braceStart).trim();
            try {
                bindings = JSON.parse(rest.slice(braceStart));
            } catch {
                bindings = {};
            }
        }
        out.push({
            id: `evt-${ts}-${out.length}`,
            ts,
            level: (level as "INFO" | "WARN" | "ERROR") ?? "INFO",
            stage: stage ?? "system",
            projectId: "current",
            message,
            bindings,
        });
    }
    return out.reverse(); // newest first
}

async function readAgents(root: string): Promise<AgentEntry[]> {
    const dirs = await listDirSafe(path.join(root, SKILLS_DIR));
    const out: AgentEntry[] = [];
    for (const dir of dirs) {
        const meta = STAGE_OF_DIR(dir);
        if (!meta) continue;
        const body = await safeReadText(path.join(root, SKILLS_DIR, dir, "SKILL.md"));
        if (!body) continue;
        const fm = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        let description = "";
        let name = meta.label;
        let tagsRaw = "";
        if (fm) {
            // Normalize line endings for cross-platform safety.
            const inner = fm[1].replace(/\r\n?/g, "\n");
            const descMatch = inner.match(/^description:\s*(.+)$/m);
            if (descMatch) description = descMatch[1].trim();
            const nameMatch = inner.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            const tagsMatch = inner.match(/^tags:\s*(.+)$/m);
            if (tagsMatch) tagsRaw = tagsMatch[1].trim();
        }
        // Accept either an explicit `tags: [a, b]` array or a comma list.
        const tags = parseTags(tagsRaw).length > 0
            ? parseTags(tagsRaw)
            : deriveTagsFromBody(body, meta.label);
        out.push({
            id: meta.stage,
            label: meta.label,
            skillPath: `skills/${dir}/SKILL.md`,
            skillBody: body,
            description,
            tags,
            stage: meta.stage,
            mode: 'llm',
            model: process.env.ANTHROPIC_MODEL ?? process.env.FACTORY_MODEL_NAME ?? '',
            enabled: true,
        });
    }
    return out;
}

function parseTags(raw: string): string[] {
    // Match comma-separated words or [a, b] array literal.
    const inner = raw.replace(/^\[|\]$/g, "");
    return inner
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function deriveTagsFromBody(body: string, label: string): string[] {
    // Pull a few single-word nouns out of the skill body so the chip row
    // is meaningful even when the frontmatter doesn't declare `tags`.
    const cleaned = body
        .replace(/^---[\s\S]*?---\s*/, "")
        .toLowerCase();
    const stop = new Set([
        "the", "and", "for", "from", "with", "into", "that", "this",
        "use", "when", "issue", "issues", "skill", "skills", "your",
        "a", "an", "of", "to", "in", "on", "by", "as", "is", "be",
        "are", "or", "if", "do", "not", "no", "never", "always",
    ]);
    const words = Array.from(
        new Set(
            cleaned.match(/[a-z][a-z\-]{3,}/g) ?? [],
        ),
    ).filter((w) => !stop.has(w));
    // Prefer words that appear early in the body (title-ish) over the rest.
    words.sort((a, b) => cleaned.indexOf(a) - cleaned.indexOf(b));
    // Skip the label itself (lowercased) so a chip doesn't duplicate the title.
    const labelLower = label.toLowerCase().replace(/\s+/g, "-");
    return words.filter((w) => w !== labelLower).slice(0, 4);
}

async function readSettings(root: string): Promise<SettingsPayload> {
    let baseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
    let defaultModel = process.env.ANTHROPIC_MODEL ?? process.env.FACTORY_MODEL_NAME ?? "";
    let pollIntervalSec = 30;
    let daemonActive = false;
    let daemonPid: number | null = null;
    let daemonUptime = 0;
    let workdir = root;

    // Read .factory-daemon/.env if it exists.
    if (await exists(path.join(root, DAEMON_ENV))) {
        const envText = await safeReadText(path.join(root, DAEMON_ENV));
        if (envText) {
            const baseMatch = envText.match(/ANTHROPIC_BASE_URL\s*=\s*([^\s#]+)/);
            if (baseMatch) baseUrl = baseMatch[1].trim();
            const modelMatch = envText.match(/ANTHROPIC_MODEL\s*=\s*([^\s#]+)/);
            if (modelMatch) defaultModel = modelMatch[1].trim();
            const pollMatch = envText.match(/FACTORY_POLL_INTERVAL\s*=\s*(\d+)/);
            if (pollMatch) pollIntervalSec = Number(pollMatch[1]);
        }
    }

    const pidRecord = await safeReadJson<{ pid?: number; startedAt?: string }>(path.join(root, '.factory', 'daemon.pid'));
    if (pidRecord?.pid) {
        try {
            process.kill(pidRecord.pid, 0);
            daemonActive = true;
            daemonPid = pidRecord.pid;
            const startedAt = Date.parse(pidRecord.startedAt ?? '');
            if (!Number.isNaN(startedAt)) daemonUptime = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        } catch {}
    }

    return {
        baseUrl,
        defaultModel,
        pollIntervalSec,
        localDaemon: {
            active: daemonActive,
            pid: daemonPid,
            uptimeSec: daemonUptime,
            workdir,
        },
    };
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export function factoryApi(): Plugin {
    const handler = async (
        req: url.URL & { method?: string },
        res: {
            statusCode: number;
            setHeader(k: string, v: string): void;
            end(body?: string): void;
        },
        root: string,
    ): Promise<void> => {
        const send = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(body));
        };
        const path = req.pathname || req.pathname === "" ? req.pathname : req.pathname;
        const route = (req as any).pathname ?? path;

        try {
            if (route === "/api/projects" && req.method === "GET") {
                const r = await readProjects(root);
                send(200, { projects: r.projects, metrics: r.metrics });
                return;
            }
            const projMatch = route.match(/^\/api\/projects\/([^/]+)(\/issues)?$/);
            if (projMatch) {
                const [, projectId, issuesSuffix] = projMatch;
                const r = await readProjects(root);
                const project = r.projects.find((p) => p.id === projectId);
                if (!project) {
                    send(404, { error: "project not found", projectId });
                    return;
                }
                const metrics = r.metrics[projectId] ?? null;
                if (issuesSuffix === "/issues") {
                    send(200, { issues: await readIssues(root, projectId) });
                } else {
                    send(200, { project, metrics, issues: await readIssues(root, projectId) });
                }
                return;
            }
            if (route === "/api/events") {
                send(200, { events: await readEvents(root) });
                return;
            }
            if (route === "/api/agents") {
                send(200, { agents: await readAgents(root) });
                return;
            }
            if (route === "/api/settings") {
                send(200, await readSettings(root));
                return;
            }
            send(404, { error: "not found", route });
        } catch (err) {
            send(500, { error: String(err) });
        }
    };

    return {
        name: "factory-api",
        configureServer(server: ViteDevServer) {
            // The control panel lives at control-panel/, but the factory
            // data (factory/state, skills, .factory/, .factory-daemon/)
            // is at the parent repo root. Walk one directory up.
            const root = path.dirname(server.config.root);
            server.middlewares.use(async (req, res, next) => {
                const u = req.url ?? "/";
                if (!u.startsWith("/api/")) return next();
                const fakeReq = { ...req, pathname: u.split("?")[0], method: req.method };
                await handler(fakeReq as any, res as any, root);
            });
        },
    };
}
