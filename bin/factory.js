#!/usr/bin/env node
/**
 * factory — the main CLI entry.
 *
 * Subcommands:
 *   install <target> [--mode local|cloud|both] [--repo owner/name] [--package <name-or-tarball>]
 *     Configure a target repo with .factory-daemon/ (config + start
 *     scripts) backed by the installed npm runtime.
 *
 *   start [--panel] [--port 5174] [--interval 30]
 *     Run the local daemon. With --panel, starts the control panel in a
 *     background child process and prints its URL.
 *
 *   panel [--port 5174]
 *     Run the control panel server only.
 *
 *   uninstall <target>
 *     Remove .factory-daemon/ from a target.
 *
 *   --help / -h
 *     Show this help.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

/**
 * Read the package version straight from package.json. We deliberately do
 * not import the package — this binary runs before npm has a chance to
 * resolve `name` exports, and reading the file is the source of truth.
 */
function readVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

const VERSION = readVersion();

const HELP = `Usage:
  factory install <target> [--mode local|cloud|both] [--repo owner/name] [--package <name-or-tarball>] [--non-interactive]
  factory start [--repo owner/name] [--panel] [--port 5174] [--interval 30]
                [--once | --daily] [--local-dir path] [--workdir path]
                [--state-dir path] [--env-file path] [--webhook-port 8080]
                [--no-env-file] [--no-fallback-env]
  factory panel [--port 5174] [--host 127.0.0.1] [--target path]
  factory uninstall <target>
  factory --version | -v
  factory --help | -h

A target is the path to a git repo where you want the factory to run.
Install uses the npm runtime without copying project source and preserves existing .env credentials.
Run start from the target repo. --once processes at most one eligible issue;
--daily runs only the review-feedback improvement stage.
`;

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq >= 0) {
                out[a.slice(2, eq)] = a.slice(eq + 1);
            } else {
                const next = argv[i + 1];
                if (next && !next.startsWith("--")) {
                    out[a.slice(2)] = next;
                    i++;
                } else {
                    out[a.slice(2)] = true;
                }
            }
        } else if (a === "-h") {
            out.help = true;
        } else if (a === "-v") {
            // Short alias for --version. Kept here (not in the long-form
            // branch) because parseArgs otherwise falls through to `_`
            // for single-letter flags.
            out.version = true;
        } else {
            out._.push(a);
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

// --version / -v is handled before subcommand dispatch so it works
// regardless of position and never collides with a subcommand name.
if (args.version) {
    process.stdout.write(`${ VERSION }\n`);
    process.exit(0);
}

function pkgRoot() {
    return packageRoot;
}

function resolvePackagePath(rel) {
    return path.join(packageRoot, rel);
}

function resolveBinPath(name) {
    return path.join(packageRoot, "bin", name);
}

function spawnChild(cmd, args, opts = {}) {
    const child = spawn(cmd, args, {
        stdio: "inherit",
        ...opts,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    forwardSignals(child);
    return child;
}

/**
 * Forward POSIX signals from the parent (factory CLI) to a spawned child
 * (daemon or panel). On Windows Node treats the equivalent signals as
 * SIGTERM, which still kills the child but cannot be propagated through
 * `tree-kill` from this code path — the simplest portable behavior is
 * "best-effort": send SIGTERM on the first signal we get, SIGKILL on
 * the second.
 */
function forwardSignals(child) {
    let killed = false;
    const forward = (sig) => {
        if (killed) return;
        if (sig === "SIGINT" || sig === "SIGTERM") {
            killed = true;
            try { child.kill("SIGTERM"); } catch { /* already exited */ }
        } else if (sig === "SIGHUP") {
            // SIGHUP is a hangup notification; on the daemon it's safe
            // to just let it die.
            try { child.kill("SIGTERM"); } catch { /* noop */ }
        }
    };
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(sig, () => forward(sig));
    }
    // Last-resort escalation: if the child doesn't exit after 5s, kill
    // it harder. Windows has no SIGKILL; Taskkill /F handles that path
    // in production where the parent is `start.cmd`.
    child.on("exit", () => {
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
            process.removeAllListeners(sig);
        }
    });
}

async function installCommand() {
    const target = args._[1];
    if (!target) {
        console.error("Error: install needs a target repo path.");
        console.error("Example: factory install ../my-app --");
        process.exit(1);
    }
    if (args.help) {
        process.stdout.write(HELP);
        return;
    }

    // Defer to the dedicated installer module — it owns the dotenv,
    // systemd unit, and env-template logic and has been battle-tested.
    const installerPath = resolvePackagePath("scripts/install-factory.mjs");
    if (!existsSync(installerPath)) {
        console.error(`Error: installer not found at ${ installerPath }`);
        process.exit(1);
    }
    const installerArgs = [target, "--mode", String(args.mode ?? "local")];
    if (args.repo) installerArgs.push("--repo", String(args.repo));
    if (args.package) installerArgs.push("--package", String(args.package));
    if (args["non-interactive"]) installerArgs.push("--non-interactive");
    if (args["install-service"]) installerArgs.push("--install-service");

    const child = spawn(process.execPath, [installerPath, ...installerArgs], {
        stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
}

async function startCommand() {
    if (args.help || args.h) {
        process.stdout.write(HELP);
        return;
    }

    // Start the daemon as a foreground process. With --panel, fork the
    // panel as a background child and print its URL when it's ready.
    const daemonScript = resolvePackagePath("scripts/factory-daemon.mjs");
    const daemonArgs = [];
    for (const name of ["repo", "interval", "local-dir", "webhook-port", "env-file", "state-dir", "workdir"]) {
        if (args[name] !== undefined) daemonArgs.push(`--${name}`, String(args[name]));
    }
    for (const name of ["once", "daily", "no-env-file", "no-fallback-env"]) {
        if (args[name]) daemonArgs.push(`--${name}`);
    }

    let panelChild = null;
    if (args.panel) {
        const panelScript = resolveBinPath("factory-panel.js");
        const panelArgs = [];
        if (args.port) panelArgs.push("--port", String(args.port));
        panelChild = spawn(process.execPath, [panelScript, ...panelArgs], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });
        panelChild.stdout?.on("data", (b) => {
            const s = b.toString();
            process.stdout.write(`[panel] ${ s }`);
            const m = s.match(/http:\/\/localhost:(\d+)/);
            if (m && !process.env.FACTORY_PANEL_URL) {
                process.env.FACTORY_PANEL_URL = `http://localhost:${ m[1] }`;
                console.error(`\nControl panel ready at http://localhost:${ m[1] }`);
            }
        });
        panelChild.stderr?.on("data", (b) => process.stderr.write(`[panel] ${ b.toString() }`));
    }

    const daemon = spawn(process.execPath, ["--", daemonScript, ...daemonArgs], {
        stdio: "inherit",
    });

    // Forward signals so Ctrl+C, kill, etc. reach the daemon child.
    // Without this, the child daemon survives parent termination on
    // POSIX, and Windows gets a dangling node.exe.
    forwardSignals(daemon);

    daemon.on("exit", (code, signal) => {
        if (panelChild && !panelChild.killed) panelChild.kill("SIGTERM");
        // Match the daemon's exit signal so callers can tell whether it
        // was killed by a signal or exited cleanly.
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
    });
}

async function panelCommand() {
    if (args.help || args.h) {
        process.stdout.write(HELP);
        return;
    }
    const panelArgs = [];
    for (const name of ["port", "host", "target"]) {
        if (args[name] !== undefined) panelArgs.push(`--${name}`, String(args[name]));
    }
    spawnChild(process.execPath, [resolveBinPath("factory-panel.js"), ...panelArgs], {
        stdio: "inherit",
    });
}

async function uninstallCommand() {
    const target = args._[1];
    if (!target) {
        console.error("Error: uninstall needs a target repo path.");
        process.exit(1);
    }
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const daemonDir = path.join(path.resolve(target), ".factory-daemon");
    if (!existsSync(daemonDir)) {
        console.error(`No .factory-daemon/ found in ${ target }`);
        process.exit(1);
    }
    await fs.rm(daemonDir, { recursive: true, force: true });
    console.log(`✓ Removed ${ daemonDir }`);
    console.log("  The npm runtime and local state were left untouched.");
}

function showHelp() {
    process.stdout.write(HELP);
}

switch (cmd) {
    case "install":
        installCommand();
        break;
    case "start":
        startCommand();
        break;
    case "panel":
        panelCommand();
        break;
    case "uninstall":
        uninstallCommand();
        break;
    case "help":
        showHelp();
        break;
    case undefined:
    case "--help":
    case "-h":
        showHelp();
        break;
    default:
        console.error(`Unknown command: ${ cmd }`);
        process.stdout.write(HELP);
        process.exit(1);
}
