#!/usr/bin/env node
/**
 * Installer for the software factory.
 *
 * Lets the user choose between:
 *   1. cloud  — GitHub Actions trigger the factory in cloud VMs (secrets
 *                live as repo secrets, no local process needed)
 *   2. local  — A local daemon polls GitHub for new issues and processes
 *                them on this machine (secrets stay local, only finished
 *                commits/PRs reach GitHub)
 *   3. both   — Install both; user can switch between modes
 *
 * Usage:
 *   # Interactive (asks which mode)
 *   node scripts/install-factory.mjs /path/to/to/target-repo
 *
 *   # Non-interactive (CI)
 *   node scripts/install-factory.mjs /path/to/to/target-repo --mode cloud
 *   node scripts/install-factory.mjs /path/to/to/target-repo --mode local
 *   node scripts/install-factory.mjs /path/to/to/target-repo --mode both
 *
 * What this installer does:
 *   - Installs software-factory-cli into the target repo via
 *     npm (no source copy — the source is open on GitHub; the npm
 *     package is the runtime artifact)
 *   - Writes .factory-daemon/ with start.sh + start.cmd + systemd /
 *     launchd / Windows service units that spawn the daemon from
 *     node_modules/software-factory-cli/scripts/factory-daemon.mjs
 *   - Writes .factory-daemon/.env (chmod 600) with the user's secrets
 *   - Wires the local daemon (only if --mode=local|both):
 *       * creates .factory-daemon/ with start.sh + factory-daemon.service
 *       * prompts for GH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL
 *       * stores them in .factory-daemon/.env (chmod 600)
 *       * optionally installs systemd / launchd unit
 *   - For --mode=cloud|both: copies GitHub Actions workflow templates
 *     from the npm package's dist/factory/templates/github/workflows/ to
 *     .github/workflows/ in the target repo
 *
 * What this installer does NOT do (deliberately):
 *   - It does NOT copy src/, skills/, fixtures/, or scripts/ from this
 *     repo into the target. The factory source is open-source on GitHub;
 *     the published npm package carries only the runtime artifacts.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, writeFileSync, existsSync, chmodSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// The published package name. Keep in sync with package.json#name.
const PACKAGE_NAME = "software-factory-cli";

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--mode") out.mode = argv[++i];
        else if (a === "--repo") out.repo = argv[++i];
        else if (a === "--non-interactive" || a === "-y") out.yes = true;
        else if (a === "--install-service") out.installService = true;
        else if (a === "--package") out.package = argv[++i];
        else if (a === "--help" || a === "-h") out.help = true;
        else out._.push(a);
    }
    return out;
}

async function ask(question, options, defaultIdx = 0) {
    if (process.env.NON_INTERACTIVE || process.argv.includes("-y")) {
        return options[defaultIdx];
    }
    console.log(question);
    options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(`Choose [1-${options.length}] (default ${defaultIdx + 1}): `);
    rl.close();
    const idx = Number(answer) - 1;
    return options[idx] !== undefined ? options[idx] : options[defaultIdx];
}

async function copyDir(src, dst) {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) await copyDir(s, d);
        else await fs.copyFile(s, d);
    }
}

async function removeLegacySourceCopy(target) {
    const legacyRoot = path.join(target, "factory");
    const markers = [
        path.join(legacyRoot, "src", "cli", "run-issue.ts"),
        path.join(legacyRoot, "scripts", "factory-daemon.mjs"),
        path.join(legacyRoot, "skills", "triage", "SKILL.md"),
    ];
    if (markers.every((marker) => existsSync(marker))) {
        await fs.rm(legacyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        console.log(`✓ Removed legacy factory source copy ${legacyRoot}`);
    } else if (existsSync(legacyRoot) && markers.some((marker) => existsSync(marker))) {
        console.warn(`⚠ ${legacyRoot} resembles a partial legacy install; left it untouched for safety`);
    }

    const copiedDaemon = path.join(target, ".factory-daemon", "factory-daemon.mjs");
    if (existsSync(copiedDaemon)) {
        await fs.rm(copiedDaemon, { force: true });
        console.log(`✓ Removed legacy copied daemon ${copiedDaemon}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args._.length === 0) {
        console.log(`Usage: node scripts/install-factory.mjs <target-repo-path> [--mode cloud|local|both] [--repo <owner/name>] [--install-service] [--package <name>]`);
        console.log(`\nDefault package: ${PACKAGE_NAME}`);
        console.log(`Override with --package to install a fork or local path (npm-installable).`);
        process.exit(args.help ? 0 : 1);
    }

    const target = path.resolve(args._[0]);
    const mode = args.mode || await ask(
        "Which mode do you want to enable?",
        [
            "cloud  — GitHub Actions runs the factory in ephemeral VMs",
            "local  — A local daemon polls/issues + processes them on this machine",
            "both   — Install both; pick at runtime",
        ],
        1, // default to local
    );

    const repo = args.repo || "";
    const pkg = args.package || PACKAGE_NAME;
    console.log(`\nInstalling factory into: ${target}`);
    console.log(`Mode: ${mode}`);
    console.log(`Package: ${pkg}\n`);

    // 0. Sanity: target must be a directory (and ideally a git repo).
    if (!existsSync(target) || !statSync(target).isDirectory()) {
        console.error(`✗ Target ${target} is not an existing directory.`);
        process.exit(1);
    }

    // 0.5. Ensure the target has a package.json — npm refuses to install
    //      a package into a directory with no manifest (it would otherwise
    //      error or silently no-op). For empty targets we write a
    //      minimal private manifest so `npm install <pkg>` lands in
    //      <target>/node_modules as expected. We DO NOT mutate an
    //      existing package.json — install leaves the user's deps alone.
    const pkgJsonPath = path.join(target, "package.json");
    if (!existsSync(pkgJsonPath)) {
        writeFileSync(pkgJsonPath, JSON.stringify({ name: path.basename(target), private: true }, null, 2));
        console.log(`✓ Wrote minimal ${pkgJsonPath} (npm requires a manifest to install into)`);
    }

    // 1. Install the factory npm package into the target. The package
    //    carries bin/, dist/, and runtime scripts: exactly the runtime
    //    surface needed by both the local daemon and the cloud workflows.
    //    We do NOT copy source: it lives on GitHub and is mirrored into
    //    compiled bundles in the npm tarball are the runtime surface.
    //    Step 0.5 above ensured package.json exists; with a manifest in
    //    place npm reliably installs into <target>/node_modules.
    //    Record an exact runtime dependency and lockfile entry so future
    //    installs reproduce the same factory release.
    const npmInstallArgs = ["install", pkg, "--no-audit", "--no-fund", "--no-save", "--no-package-lock"];
    // Invoke the npm CLI directly through node on Windows. Spawning
    // `npm` on Windows hits Node's known issue with .cmd shims and the
    // shell:false default in Node 22+, so resolve to the npm-cli.js
    // entry and exec via process.execPath — same trick bin/factory.js
    // already uses for npm on Windows.
    const isWin = process.platform === "win32";
    let npmRunner = "npm";
    let npmInvokeArgs = npmInstallArgs;
    if (isWin) {
        const findOnPath = (name) => {
            const sep = ";";
            for (const dir of (process.env.PATH || "").split(sep).filter(Boolean)) {
                const full = path.join(dir, name);
                if (existsSync(full)) return full;
                if (!/\.[a-z]+$/i.test(name)) {
                    for (const ext of (process.env.PATHEXT || "").split(";")) {
                        const c2 = full + ext;
                        if (existsSync(c2)) return c2;
                    }
                }
            }
            return null;
        };
        const npmCmd = findOnPath("npm.cmd");
        const npmCli = path.join(path.dirname(npmCmd || process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
        npmRunner = process.execPath;
        npmInvokeArgs = [npmCli, ...npmInstallArgs];
    }
    console.log(`Running: ${npmRunner === "npm" ? "npm" : "node <npm-cli>"} ${npmInstallArgs.join(" ")}`);
    const npmResult = spawnSync(npmRunner, npmInvokeArgs, { cwd: target, stdio: "inherit", shell: false });
    if (npmResult.status !== 0) {
        console.error(`\n✗ npm install failed (exit ${npmResult.status}).`);
        console.error(`  Confirm ${pkg} is published (or use --package to point at a fork).`);
        process.exit(npmResult.status ?? 1);
    }
    // The package's canonical install location depends on whether the
    // user passed a local tarball/path (--package) or the published npm
    // registry name. For a tarball or local path, npm still installs it
    // under its canonical name (read from the package.json inside the
    // tarball), NOT under the path's basename. For a registry name the
    // install location matches the name directly.
    //
    // We pass `--no-save --no-package-lock` so the install doesn't mutate
    // the target repo's package.json or create a lockfile — the factory is
    // an out-of-band runtime, not a user-managed dependency.
    const isLocalPath = /\.(tgz|tar\.gz)$/i.test(pkg) || path.isAbsolute(pkg);
    const installedPkgName = isLocalPath ? PACKAGE_NAME : pkg;
    const installedPath = path.join(target, "node_modules", ...installedPkgName.split("/"));
    if (!existsSync(installedPath)) {
        console.error(`\n✗ ${pkg} did not land at ${installedPath} after npm install.`);
        process.exit(1);
    }
    console.log(`✓ Installed ${installedPkgName} → ${installedPath}`);
    await removeLegacySourceCopy(target);

    // 2. Append runtime exclusions to .gitignore. We only need TWO entries
    //    now: the daemon .env (secrets) and the local state directory.
    //    No more "factory/" rule — the runtime lives in node_modules,
    //    which every gitignore already excludes.
    try {
        const gi = path.join(target, ".gitignore");
        let giText = "";
        if (existsSync(gi)) giText = readFileSync(gi, "utf-8");
        const lines = new Set(giText.split(/\r?\n/).map((line) => line.trim()));
        const missing = [".factory/", ".factory-daemon/.env"].filter((entry) => !lines.has(entry));
        if (missing.length) {
            const sep = giText === "" || /\r?\n$/.test(giText) ? "" : "\n";
            giText = `${giText}${sep}# factory runtime state and local secrets (installed by software-factory)\n${missing.join("\n")}\n`;
            writeFileSync(gi, giText, "utf-8");
            console.log(`✓ Excluded ${missing.join(" + ")} from git`);
        }
    } catch (err) {
        console.warn(`⚠ Could not update .gitignore (${String(err).split("\n")[0]}); continuing install`);
    }

    // 3. Cloud-specific: copy workflow templates to .github/workflows/.
    //    The templates live INSIDE the installed npm package so they
    //    ship with the version pinned in the target's package.json.
    if (mode === "cloud" || mode === "both") {
        const wfSrc = path.join(installedPath, "dist", "factory", "templates", "github", "workflows");
        if (existsSync(wfSrc)) {
            await copyDir(wfSrc, path.join(target, ".github", "workflows"));
            console.log("✓ Copied workflow templates to .github/workflows/");
        } else {
            console.warn(`⚠ ${wfSrc} not found in the installed package; cloud workflows not installed`);
        }
        console.log("\n  ⚠ Set these secrets on the target repo via `gh secret set`:");
        console.log("    gh secret set ANTHROPIC_AUTH_TOKEN --repo <owner>/<repo>");
        console.log("    gh secret set ANTHROPIC_BASE_URL   --repo <owner>/<repo>");
        console.log("    gh secret set ANTHROPIC_MODEL      --repo <owner>/<repo>");
    }

    // 4. Local-specific: daemon wrappers + .env + (optional) service unit.
    if (mode === "local" || mode === "both") {
        const daemonDir = path.join(target, ".factory-daemon");
        await fs.mkdir(daemonDir, { recursive: true });

        // Path to the daemon script as installed via npm. All wrapper
        // scripts (start.sh, start.cmd, systemd unit, launchd plist)
        // resolve to this path so the daemon never has to be copied.
        // Use forward slashes everywhere we embed a path into a bash /
        // systemd template: Git Bash / WSL don't always grok Windows
        // backslashes, and Node accepts both on every platform.
        const daemonScriptInPkg = path.join(installedPath, "scripts", "factory-daemon.mjs").replace(/\\/g, "/");

        // Wrapper start.sh (POSIX). The daemon itself loads .env via its
        // built-in --env-file loader — keeps the wrapper free of bash
        // dotenv quirks.
        const startSh = `#!/usr/bin/env bash
# Start the factory daemon. .env is loaded by the daemon itself.
# Daemon lives in node_modules/software-factory-cli (installed by npm).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node "${daemonScriptInPkg}" "$@"
`;
        writeFileSync(path.join(daemonDir, "start.sh"), startSh);
        chmodSync(path.join(daemonDir, "start.sh"), 0o755);

        // Wrapper start.cmd (Windows). Likewise defers env loading to the
        // daemon — old code shell-parsed .env in cmd and silently failed.
        const startCmd = `@echo off
REM Start the factory daemon. .env is loaded by the daemon itself.
REM Usage:  start.cmd [extra args forwarded to factory-daemon.mjs]
REM Daemon lives in node_modules\\software-factory-cli (installed by npm).
setlocal
cd /D "%~dp0\\.."
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found in PATH. Install Node.js 20+ from https://nodejs.org/.
  exit /b 1
)
node "${daemonScriptInPkg}" %*
set "FACTORY_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %FACTORY_EXIT_CODE%
`;
        writeFileSync(path.join(daemonDir, "start.cmd"), startCmd);
        console.log(`✓ Wrote start.sh + start.cmd (spawn daemon from ${path.relative(target, daemonScriptInPkg)})`);

        // .env template.
        const envTpl = `# Generated by factory installer. Mode = local.
# Secrets live HERE, not on GitHub. File is chmod 600.
GH_TOKEN=ghp_replace_me
ANTHROPIC_AUTH_TOKEN=sk-ant-replace_me
ANTHROPIC_BASE_URL=
ANTHROPIC_MODEL=
FACTORY_AGENT_MODE=llm
FACTORY_GH_REPO=${repo || "owner/name"}
FACTORY_POLL_INTERVAL=30
`;
        writeFileSync(path.join(daemonDir, ".env.template"), envTpl);

        // Never overwrite an existing credential file during upgrades.
        const envPath = path.join(daemonDir, ".env");
        if (existsSync(envPath)) {
            console.log(`✓ Preserved existing ${envPath}`);
        } else if (!args.yes) {
            console.log("\n  Provide GitHub + LLM credentials for the local daemon:");
            const rl = readline.createInterface({ input, output });
            const ghTok = (await rl.question("  GH_TOKEN (or blank to set later): ")).trim();
            const antTok = (await rl.question("  ANTHROPIC_AUTH_TOKEN (or blank to set later): ")).trim();
            const baseUrl = (await rl.question("  ANTHROPIC_BASE_URL (or blank to use environment fallback): ")).trim();
            const model = (await rl.question("  ANTHROPIC_MODEL (or blank to use environment fallback): ")).trim();
            rl.close();
            const realEnv = `# Local factory daemon secrets (chmod 600)
GH_TOKEN=${ghTok || "ghp_replace_me"}
ANTHROPIC_AUTH_TOKEN=${antTok || "sk-ant-replace_me"}
ANTHROPIC_BASE_URL=${baseUrl}
ANTHROPIC_MODEL=${model}
FACTORY_AGENT_MODE=llm
FACTORY_GH_REPO=${repo || "owner/name"}
FACTORY_POLL_INTERVAL=30
`;
            writeFileSync(envPath, realEnv);
            chmodSync(envPath, 0o600);
            console.log(`✓ Wrote ${envPath} (chmod 600)`);
        } else {
            writeFileSync(envPath, envTpl.replace("ghp_replace_me", "REPLACE_ME"));
            chmodSync(envPath, 0o600);
            console.log(`✓ Wrote template ${envPath} - fill in before starting`);
        }

        // systemd / launchd / Windows service unit (optional).
        if (args.installService) {
            await installService(target, daemonDir, daemonScriptInPkg);
        }

        // README addendum.
        const readme = path.join(target, "FACTORY_DAEMON.md");
        writeFileSync(readme, `# Factory Daemon (local mode)

This target repo has the **software-factory** daemon installed under
\`.factory-daemon/\`. The daemon itself lives in
\`node_modules/software-factory-cli/scripts/factory-daemon.mjs\`
and is wired up by the wrappers here.

## Install / upgrade

The factory is published as the npm package
\`software-factory-cli\` (source on GitHub:
[189-sketch/software-factory](https://github.com/189-sketch/software-factory)).
Upgrade by re-running \`npm install software-factory-cli\` —
the wrappers and env template in this directory stay put.

## Run manually

\`\`\`
# Linux / macOS
./.factory-daemon/start.sh

# Windows (cmd or PowerShell)
.factory-daemon\\start.cmd
\`\`\`

The daemon polls \`$FACTORY_GH_REPO\` every \`$FACTORY_POLL_INTERVAL\` seconds,
processing any new issues end-to-end (triage → spec → implement → review →
verify → push).

## Run as a system service

\`\`\`
# systemd (Linux)
sudo systemctl enable --now ./.factory-daemon/factory-daemon.service

# launchd (macOS)
cp .factory-daemon/com.github.factory-daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.github.factory-daemon.plist

# Windows Service (PowerShell as Administrator)
.factory-daemon\\install-windows-service.ps1 -RepoPath "$(pwd)"
# Then:
net start FactoryDaemon
\`\`\`

The Windows installer auto-detects NSSM (preferred) or falls back to sc.exe.

## Secrets

Secrets live in \`.factory-daemon/.env\` (chmod 600), never on GitHub.

| Variable | Purpose |
|---|---|
| \`GH_TOKEN\` | \`gh\` CLI auth for pushing branches + creating PRs |
| \`ANTHROPIC_AUTH_TOKEN\` | LLM API auth |
| \`ANTHROPIC_BASE_URL\` | Anthropic-compatible base URL; required from an environment source |
| \`ANTHROPIC_MODEL\` | Model id; required from an environment source |
| \`FACTORY_GH_REPO\` | \`owner/name\` of the target repo |
| \`FACTORY_POLL_INTERVAL\` | Seconds between polls (default: 30) |

### Optional: skip the .env entirely

The daemon gracefully falls back when secrets aren't set in \`.env\`:

- \`GH_TOKEN\` — falls back to \`gh auth token\` (uses the active \`gh\` CLI
  login on this machine). If you've already run \`gh auth login\`, no token
  configuration is required.
- \`ANTHROPIC_AUTH_TOKEN\`, \`ANTHROPIC_BASE_URL\`, \`ANTHROPIC_MODEL\` — fall
  back to the \`env\` block of \`~/.claude/settings.json\`. If you have
  Claude Code configured there, the daemon reuses those credentials.

Explicit values in \`.env\` always win; real shell env wins over \`.env\`;
\`--no-env-file\` / \`--no-fallback-env\` disable each respectively.

## State

Each processed issue writes:
- \`.factory/state-<n>.json\` - full pipeline result
- \`.factory/daemon.log\` - timestamped log with structured fields
`);
        console.log("✓ Wrote FACTORY_DAEMON.md");
    }

    console.log(`\n✅ Factory installed in mode: ${mode}`);
    console.log(`\nNext steps:`);
    if (mode === "cloud" || mode === "both") console.log("  1. gh secret set ANTHROPIC_AUTH_TOKEN --repo <owner>/<repo>");
    if (mode === "local" || mode === "both") console.log(`  1. ${mode === "local" ? "Fill in" : "Verify"} .factory-daemon/.env`);
    console.log("  2. Open a test issue on the target repo");
    if (mode === "cloud" || mode === "both") console.log("  3. The workflow will trigger automatically");
    if (mode === "local" || mode === "both") console.log("  3. Run ./.factory-daemon/start.sh — daemon polls every 30s");
}

async function installService(target, daemonDir, daemonScriptInPkg) {
    const isWin = process.platform === "win32";
    if (isWin) {
        // Windows: copy the PowerShell service installer from the installed
        // npm package so the user always gets the version that matches the
        // daemon they're about to register.
        const psSrc = path.join(path.dirname(daemonScriptInPkg), "install-windows-service.ps1");
        if (existsSync(psSrc)) {
            await fs.copyFile(psSrc, path.join(daemonDir, "install-windows-service.ps1"));
            console.log("✓ Wrote install-windows-service.ps1 — run it as Administrator to register the Windows service");
        } else {
            console.warn(`⚠ ${psSrc} not found in the installed package; Windows service installer not copied`);
        }
        return;
    }
    const unitName = "factory-daemon.service";
    const unit = `[Unit]
Description=Software Factory Daemon (local mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${target}
EnvironmentFile=${daemonDir}/.env
ExecStart=/usr/bin/env node ${daemonScriptInPkg}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
    writeFileSync(path.join(daemonDir, unitName), unit);

    // macOS launchd plist for completeness.
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.github.factory-daemon</string>
    <key>WorkingDirectory</key><string>${target}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>node</string>
        <string>${daemonScriptInPkg}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
`;
    writeFileSync(path.join(daemonDir, "com.github.factory-daemon.plist"), plist);
    console.log("✓ Wrote systemd + launchd units");
}

main().catch((e) => { console.error(e); process.exit(1); });
