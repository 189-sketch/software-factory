#!/usr/bin/env node
/**
 * Build the factory orchestrator and skills into a single distributable
 * bundle under dist/factory/.
 *
 * Why a bundle:
 *   - Target projects don't need TypeScript, tsx, or the source tree.
 *     They install the npm package and get a single JS file.
 *   - Skills are JSON, copied alongside the bundle so the daemon can
 *     load them without parsing Markdown frontmatter at runtime.
 *
 * Output:
 *   dist/factory/orchestrator.js   — single ESM bundle, all TS deps
 *                                     inlined, ready for daemon import
 *   dist/factory/skills/<id>.json  — pre-parsed skill bodies
 */
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

async function main() {
    const outDir = path.join(factoryRoot, "dist", "factory");
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });

    // Bundle the orchestrator + every agent it depends on into one ESM file.
    await build({
        entryPoints: {
            orchestrator: path.join(factoryRoot, "src", "orchestrator", "index.ts"),
            "run-issue": path.join(factoryRoot, "src", "cli", "run-issue.ts"),
            "agent-runtime": path.join(factoryRoot, "src", "core", "agent-runtime.ts"),
        },
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        outdir: outDir,
        // Mark runtime packages as external — the daemon/CLI finds them
        // in the user's node_modules at install time. Playwright is
        // optional (only the verify-behavior agent needs it); if it's
        // missing, that agent is a no-op, the rest of the pipeline works.
        external: [
            "@earendil-works/pi-agent-core",
            "@earendil-works/pi-ai",
            "playwright-core",
            "playwright",
            "chromium-bidi",
            "undici",
        ],
        sourcemap: false,
        logLevel: "info",
    });

    // Skills: read every skills/<id>/SKILL.md, parse the frontmatter,
    // and dump a JSON blob alongside the bundle so the daemon doesn't
    // need Markdown parsing at runtime.
    const skillsSrc = path.join(factoryRoot, "skills");
    const skillsOut = path.join(outDir, "skills");
    await fs.mkdir(skillsOut, { recursive: true });
    const dirs = await fs.readdir(skillsSrc, { withFileTypes: true });
    let count = 0;
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const skillPath = path.join(skillsSrc, dir.name, "SKILL.md");
        let body;
        try {
            body = await fs.readFile(skillPath, "utf-8");
        } catch {
            continue;
        }
        const fmMatch = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        let description = "";
        let name = dir.name;
        let tagsRaw = "";
        if (fmMatch) {
            const inner = fmMatch[1].replace(/\r\n?/g, "\n");
            const descMatch = inner.match(/^description:\s*(.+)$/m);
            if (descMatch) description = descMatch[1].trim();
            const nameMatch = inner.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            const tagsMatch = inner.match(/^tags:\s*(.+)$/m);
            if (tagsMatch) tagsRaw = tagsMatch[1].trim();
        }
        const tags = parseTags(tagsRaw);
        await fs.writeFile(
            path.join(skillsOut, `${dir.name}.json`),
            JSON.stringify({ id: dir.name, name, description, body, tags }),
            "utf-8",
        );
        count++;
    }

    // A small index the daemon reads to know what skills exist.
    await fs.writeFile(
        path.join(outDir, "skills", "index.json"),
        JSON.stringify({ skills: dirs.filter((d) => d.isDirectory()).map((d) => d.name) }),
        "utf-8",
    );

    // Render the GitHub Actions workflow templates. We read
    // `package.json#version` as the single source of truth and substitute it
    // into every `software-factory-cli@__FACTORY_VERSION__` placeholder.
    // The rendered files land under `dist/factory/templates/github/workflows`
    // so the npm tarball ships the same version the user just installed.
    const pkgJson = JSON.parse(await fs.readFile(path.join(factoryRoot, "package.json"), "utf-8"));
    const version = pkgJson.version;
    const tplSrc = path.join(factoryRoot, "templates");
    const tplOut = path.join(outDir, "templates");
    let templateCount = 0;
    if (existsSync(tplSrc)) {
        await copyDirAndReplace(tplSrc, tplOut, "__FACTORY_VERSION__", version);
        templateCount = (await fs.readdir(path.join(tplOut, "github", "workflows"))).length;
    } else {
        console.warn(`! ${tplSrc} missing; templates not rendered`);
    }

    // Copy the Claude Code adapter into `dist/factory/agent-backends/`
    // so the npm tarball ships the adapter at the path documented in
    // `specs/2026-09-16-unified-agent-runtime/validation.md` DoD. The
    // esbuild bundle (`agent-runtime.js`) already inlines the adapter
    // body for callers that go through `AgentRuntime.runStage`, but
    // external consumers expect to find the adapter module on disk at
    // the documented path.
    //
    // The verbatim copy used to leave `from "./agent-backends.mjs"`
    // dangling (no such sibling under dist/factory/agent-backends/),
    // so any external consumer importing the documented path died with
    // ERR_MODULE_NOT_FOUND. Rewrite the import to the package-root
    // `runtime/` copy — `../../../runtime/agent-backends.mjs` resolves
    // identically in the dev repo and in the installed npm package
    // (both ship `runtime/` at the root, two levels up from here).
    const adapterSrc = path.join(factoryRoot, "runtime", "claude-code-backend.mjs");
    const adapterOutDir = path.join(outDir, "agent-backends");
    if (existsSync(adapterSrc)) {
        await fs.mkdir(adapterOutDir, { recursive: true });
        const adapterOut = path.join(adapterOutDir, "claude-code.mjs");
        const adapterText = await fs.readFile(adapterSrc, "utf8");
        await fs.writeFile(
            adapterOut,
            adapterText
                .replaceAll(
                    `from "./agent-backends.mjs"`,
                    `from "../../../runtime/agent-backends.mjs"`,
                )
                // JSDoc type-only reference (`@param {import("./agent-backends.mjs")...}`)
                // — rewrite it too so the shipped copy is fully
                // self-consistent for consumers that typecheck it.
                .replaceAll(
                    `import("./agent-backends.mjs")`,
                    `import("../../../runtime/agent-backends.mjs")`,
                ),
        );
    }

    console.log(`✓ Built orchestrator + ${ count } skills + ${ templateCount } templates into ${ outDir }`);
}

/**
 * Recursively copy `src` into `dst`, replacing every occurrence of
 * `placeholder` with `value` inside text files. Used by the template
 * render step to inject the current package version into workflow files.
 */
async function copyDirAndReplace(src, dst, placeholder, value) {
    await fs.mkdir(dst, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            await copyDirAndReplace(s, d, placeholder, value);
        } else if (entry.isFile()) {
            const original = await fs.readFile(s, "utf-8");
            if (original.includes(placeholder)) {
                await fs.writeFile(d, original.split(placeholder).join(value), "utf-8");
            } else {
                await fs.writeFile(d, original, "utf-8");
            }
        }
    }
}

function parseTags(raw) {
    const inner = raw.replace(/^\[|\]$/g, "");
    return inner
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
