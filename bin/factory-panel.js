#!/usr/bin/env node
/**
 * factory-panel — the control-panel HTTP server.
 *
 * Serves the pre-built React dashboard and exposes the same /api/*
 * endpoints the development Vite plugin does, so the panel is functional
 * without going through a JS dev server. Target projects get a working
 * dashboard as soon as they `npm install` this package.
 *
 * Usage:
 *   factory-panel [--port 5174] [--target <path>] [--version]
 *
 * If --target is not given, the panel looks at process.cwd()'s
 * .factory-daemon/ for the daemon's poll interval and .factory/ for
 * state files. This matches the layout start.sh drops in.
 */
import http from "node:http";
import { promises as fs, createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));

// --version / -v: print and exit before binding any port. Useful in CI
// scripts and shells that probe installed package versions.
if (args.version) {
    let version = "0.0.0";
    try {
        const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
        if (pkg.version) version = pkg.version;
    } catch { /* package.json missing — fall back to placeholder */ }
    process.stdout.write(`${ version }\n`);
    process.exit(0);
}

const PORT = Number(args.port) || 5174;
const HOST = args.host || "127.0.0.1";

// The target repo whose state we visualize. Default: process.cwd().
const targetRoot = path.resolve(args.target || process.cwd());

const DIST_DIR = path.join(packageRoot, "dist", "panel");

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
            else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
                out[a.slice(2)] = argv[++i];
            } else {
                out[a.slice(2)] = true;
            }
        } else if (a === "-h") {
            out.help = true;
        } else if (a === "-v") {
            // Short alias for --version. parseArgs otherwise routes
            // single-letter flags into `_`, where they'd be mistaken
            // for positional arguments.
            out.version = true;
        } else out._.push(a);
    }
    return out;
}

function mimeOf(p) {
    const ext = path.extname(p).toLowerCase();
    return ({
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".map": "application/json",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    })[ext] || "application/octet-stream";
}

async function safeRead(p) {
    try { return await fs.readFile(p, "utf-8"); } catch { return null; }
}
async function safeReadJson(p) {
    try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return null; }
}
async function listDir(p) {
    try { return await fs.readdir(p); } catch { return []; }
}
async function exists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

/* -------------------------------------------------------------------------- */
/* API handlers — same surface as control-panel/vite/factoryApi.ts              */
/* -------------------------------------------------------------------------- */

async function readProjects() {
    const out = [];
    const pkg = await safeReadJson(path.join(targetRoot, "package.json"));
    const envText = await safeRead(path.join(targetRoot, ".factory-daemon", ".env"));
    const configuredRepo = envText?.match(/FACTORY_GH_REPO\s*=\s*([^\s#]+)/)?.[1]?.trim() || null;

    const mainRepoUrl = (() => {
        if (!pkg?.repository) return null;
        if (typeof pkg.repository === "string") return pkg.repository;
        return pkg.repository.url ?? null;
    })();

    const dirName = path.basename(targetRoot);
    // Use a Map keyed by repo URL so a current + monitored pair pointing at
    // the same repository collapses to one entry (the current one wins).
    const projects = new Map();
    const mainKey = mainRepoUrl || "unconfigured";
    projects.set(mainKey, {
        id: "current",
        name: dirName,
        repo: mainRepoUrl || "unconfigured",
        defaultBranch: "main",
        isCurrent: true,
    });
    if (configuredRepo && configuredRepo !== mainRepoUrl) {
        projects.set(configuredRepo, {
            id: configuredRepo.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
            name: configuredRepo.split("/")[1] ?? configuredRepo,
            repo: configuredRepo,
            defaultBranch: "main",
            isCurrent: false,
        });
    }
    return Array.from(projects.values());
}

async function computeProjectMetrics() {
    const out = {
        merged7d: 0,
        rejected30d: 0,
        approved30d: 0,
        avgTimeToMergeMs: null,
        started24h: 0,
        closed24h: 0,
    };
    const stateFiles = await listDir(path.join(targetRoot, ".factory", "issues"));
    if (stateFiles.length === 0) return out;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const sevenDayMs = 7 * dayMs;
    const thirtyDayMs = 30 * dayMs;
    const mergeDurations = [];

    for (const f of stateFiles) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson(path.join(targetRoot, ".factory", "issues", f));
        if (!data) continue;
        const triageStart = findStageTime(data, "triage", "startedAt");
        const mergeEnd = findStageTime(data, "merge", "endedAt");
        const review = data.review;

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
        if (review?.verdict === "REJECT") {
            const endMs = Date.parse(findStageTime(data, "review", "endedAt") ?? "");
            if (!Number.isNaN(endMs) && now - endMs <= thirtyDayMs) out.rejected30d++;
        }
        if (review?.verdict === "APPROVE") {
            const endMs = Date.parse(findStageTime(data, "review", "endedAt") ?? "");
            if (!Number.isNaN(endMs) && now - endMs <= thirtyDayMs) out.approved30d++;
        }
        const stages = ["triage", "spec", "implementation", "review", "verify", "merge"];
        for (const s of stages) {
            const startedAt = findStageTime(data, s, "startedAt");
            const endedAt = findStageTime(data, s, "endedAt");
            if (startedAt) {
                const ms = Date.parse(startedAt);
                if (!Number.isNaN(ms) && now - ms <= dayMs) out.started24h++;
            }
            if (endedAt) {
                const ms = Date.parse(endedAt);
                if (!Number.isNaN(ms) && now - ms <= dayMs) out.closed24h++;
            }
        }
    }

    if (mergeDurations.length > 0) {
        out.avgTimeToMergeMs = Math.round(
            mergeDurations.reduce((a, b) => a + b, 0) / mergeDurations.length,
        );
    }
    return out;
}

function findStageTime(data, stage, key) {
    return data?.stages?.[stage]?.[key];
}

async function readIssues() {
    const out = [];
    // Live state files: only real, factory- completed issues count.
    const stateFiles = await listDir(path.join(targetRoot, ".factory", "issues"));
    for (const f of stateFiles) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson(path.join(targetRoot, ".factory", "issues", f));
        if (data) out.push(data);
    }
    // Discovered issues: GitHub open issues via the gh CLI, if available.
    // The CLI must be authenticated; otherwise the panel stays with state-only.
    const repo = await readCurrentRepo();
    if (repo) {
        try {
            const { stdout } = await execFileP("gh", [
                "issue", "list", "--repo", repo, "--state", "open",
                "--limit", "50",
                "--json", "number,title,body,author,createdAt,url,labels",
            ], { timeout: 4000 });
            for (const raw of JSON.parse(stdout)) {
                out.push({ _discovered: true, issue: raw });
            }
        } catch { /* gh unavailable */ }
    }
    return out;
}

async function readCurrentRepo() {
    const repo = (await readProjects())[0]?.repo;
    return repo && repo !== 'unconfigured' ? repo : null;
}

async function readEvents() {
    const text = await safeRead(path.join(targetRoot, ".factory", "daemon.log"));
    if (!text) return [];
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const m = raw.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const [, ts, level, stage, rest] = m;
        let message = rest, bindings = {};
        const bi = rest.indexOf("{");
        if (bi >= 0) {
            message = rest.slice(0, bi).trim();
            try { bindings = JSON.parse(rest.slice(bi)); } catch {}
        }
        out.push({
            id: `evt-${ts}-${out.length}`,
            ts, level, stage, projectId: "current",
            message, bindings,
        });
    }
    return out.reverse();
}

async function readAgents() {
    // Skills ship pre-built under dist/factory/skills/. They were copied
    // there by the factory build, alongside the orchestrator bundle.
    const out = [];
    const skillsDir = path.join(packageRoot, "dist", "factory", "skills");
    if (!existsSync(skillsDir)) return out;
    const dirs = await listDir(skillsDir);
    const stages = { triage: ['triage', 'Triage'], spec: ['spec', 'Spec'], implementation: ['implementation', 'Implementation'], 'review-pr': ['review', 'Review PR'], 'verify-behavior': ['verify', 'Verify Behavior'], 'improve-review-pr': ['improve', 'Improve Review PR'] };
    const settings = await readSettings();
    for (const f of dirs) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson(path.join(skillsDir, f));
        const meta = stages[data?.id];
        if (data && meta) out.push({ id: meta[0], stage: meta[0], label: meta[1], skillPath: `skills/${data.id}/SKILL.md`, skillBody: data.body, description: data.description || '', tags: data.tags || [], mode: 'llm', model: settings.defaultModel, enabled: true });
    }
    return out;
}

async function readSettings() {
    let baseUrl = process.env.ANTHROPIC_BASE_URL || "";
    let defaultModel = process.env.ANTHROPIC_MODEL || process.env.FACTORY_MODEL_NAME || "";
    let pollIntervalSec = 30;
    let daemonActive = false;
    let workdir = targetRoot;

    const envText = await safeRead(path.join(targetRoot, ".factory-daemon", ".env"));
    if (envText) {
        const base = envText.match(/ANTHROPIC_BASE_URL\s*=\s*([^\s#]+)/);
        if (base) baseUrl = base[1].trim();
        const model = envText.match(/ANTHROPIC_MODEL\s*=\s*([^\s#]+)/);
        if (model) defaultModel = model[1].trim();
        const poll = envText.match(/FACTORY_POLL_INTERVAL\s*=\s*(\d+)/);
        if (poll) pollIntervalSec = Number(poll[1]);
    }
    const pidPath = path.join(targetRoot, ".factory", "daemon.pid");
    const pidRecord = await safeReadJson(pidPath);
    let pid = null;
    let uptimeSec = 0;
    if (pidRecord?.pid) {
        try {
            process.kill(pidRecord.pid, 0);
            daemonActive = true;
            pid = pidRecord.pid;
            const startedAtMs = pidRecord.startedAt ? Date.parse(pidRecord.startedAt) : NaN;
            if (Number.isFinite(startedAtMs)) {
                uptimeSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
            }
        } catch {}
    }
    return {
        baseUrl, defaultModel, pollIntervalSec,
        localDaemon: { active: daemonActive, pid, uptimeSec, workdir },
    };
}

/* -------------------------------------------------------------------------- */
/* HTTP server                                                                */
/* -------------------------------------------------------------------------- */

async function serveStatic(req, res, urlPath) {
    let filePath = path.resolve(DIST_DIR, '.' + (urlPath === "/" ? "/index.html" : urlPath));
    const relative = path.relative(DIST_DIR, filePath);
    // Reject any path that escapes DIST_DIR, including the bare `..` segment
    // (which Node's URL normally collapses to `/`, but a direct req.url
    // passthrough could still surface it).
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        res.statusCode = 404; res.end('Not found'); return;
    }
    if (!existsSync(filePath)) {
        // SPA fallback: any unknown path returns index.html.
        filePath = path.join(DIST_DIR, "index.html");
    }
    try {
        const stream = createReadStream(filePath);
        res.statusCode = 200;
        res.setHeader("Content-Type", mimeOf(filePath));
        stream.pipe(res);
    } catch {
        res.statusCode = 404;
        res.end("Not found");
    }
}

function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host}`);
    const route = u.pathname;
    try {
        if (req.method === "GET") {
            if (route === "/api/projects") {
                const projects = await readProjects();
                const metrics = {};
                for (const p of projects) metrics[p.id] = await computeProjectMetrics();
                return send(res, 200, { projects, metrics });
            }
            if (route === "/api/events") {
                return send(res, 200, { events: await readEvents() });
            }
            if (route === "/api/agents") {
                return send(res, 200, { agents: await readAgents() });
            }
            if (route === "/api/settings") {
                return send(res, 200, await readSettings());
            }
            const m = route.match(/^\/api\/projects\/([^/]+)(\/issues)?$/);
            if (m) {
                return send(res, 200, {
                    project: (await readProjects()).find((p) => p.id === m[1]) ?? null,
                    issues: await readIssues(),
                });
            }
        }
        // Everything else is a static asset from the built panel.
        return serveStatic(req, res, route);
    } catch (err) {
        send(res, 500, { error: String(err) });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Control panel ready at http://${ HOST }:${ PORT }`);
    console.log(`Reading factory state from ${ targetRoot }`);
});
