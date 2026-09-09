import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * SkillLoader reads the canonical SKILL.md files used by the agents.
 *
 * Each agent owns one skill file. The agent module passes the skill name and
 * the loader returns the body so the agent can follow it. The pi framework
 * pattern is: agent loop reads the skill, decides which tools to call, and
 * returns the structured result the skill defines.
 *
 * Two storage shapes are supported so the same loader works in both
 *   - source mode (dev): <skillsRoot>/<skillName>/SKILL.md
 *   - bundle mode (npm): <skillsRoot>/<skillName>.json  (built manifest)
 *
 * The bundle layout is produced by scripts/build-factory.mjs and ships in
 * the npm tarball under dist/factory/skills/. The source layout lives at
 * the repo root in skills/. SKILL.md takes priority so a dev with both
 * present always sees the canonical source.
 */
export class SkillLoader {
    constructor(private readonly skillsRoot: string, private readonly workdir?: string) {}

    async load(skillName: string): Promise<{ name: string; description: string; body: string }> {
        if (!/^[a-z][a-z0-9-]*$/.test(skillName)) throw new Error('Invalid skill name');
        if (this.workdir && skillName === 'review-pr') {
            const override = path.join(this.workdir, '.agents', 'skills', skillName, 'SKILL.md');
            try { return parseFrontmatter(await fs.readFile(override, 'utf-8')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const mdFile = path.join(this.skillsRoot, skillName, "SKILL.md");
        try {
            const raw = await fs.readFile(mdFile, "utf-8");
            return parseFrontmatter(raw);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            // Fall through to the bundle-shape manifest.
        }
        const jsonFile = path.join(this.skillsRoot, `${skillName}.json`);
        try {
            const raw = await fs.readFile(jsonFile, "utf-8");
            const obj = JSON.parse(raw);
            return {
                name: obj.name ?? skillName,
                description: obj.description ?? "",
                body: typeof obj.body === "string" ? obj.body : "",
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            throw new Error(
                `Skill '${skillName}' not found under ${this.skillsRoot} ` +
                `(looked for ${mdFile} and ${jsonFile})`,
            );
        }
    }

    async list(): Promise<string[]> {
        const entries = await fs.readdir(this.skillsRoot, { withFileTypes: true });
        const names = new Set<string>();
        for (const e of entries) {
            if (e.isDirectory()) {
                names.add(e.name);
            } else if (e.isFile() && e.name.endsWith(".json") && e.name !== "index.json") {
                names.add(e.name.slice(0, -".json".length));
            }
        }
        return [...names];
    }
}

function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
        return { name: "unknown", description: "", body: raw };
    }
    const fm = match[1];
    const body = match[2];
    const fmLines = fm.split("\n");
    const fields: Record<string, string> = {};
    for (const line of fmLines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        fields[key] = val;
    }
    return {
        name: fields.name ?? "unknown",
        description: fields.description ?? "",
        body,
    };
}
