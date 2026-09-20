/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T10.1.
 *
 * Plain-JS `runtime/decisions.yaml` loader for the panel API.
 *
 * The panel HTTP surface (`runtime/panel-api.mjs`) runs as plain Node
 * .mjs with no TypeScript runtime, so this module re-implements the
 * small YAML 1.2 subset parser + schema validator from
 * `src/core/decisions.ts` in JS (same approach `scripts/freshness-poc.mjs`
 * uses for its TS helpers). No new dependencies: `js-yaml` stays out of
 * the install surface for a 15-line schema.
 *
 * Entry point: `loadDecisionsJson(path?)` — reads, parses and validates
 * the file, returning the JSON-ready shape
 * `{ version, decisions, composite, fallback }`. On a missing,
 * malformed, or schema-invalid file it throws an `Error` whose message
 * starts with `Invalid decisions.yaml:` (mirrors
 * `runDecisionsPreCheck()` in the TS loader) so the panel API can turn
 * the failure into its standard error envelope instead of crashing.
 *
 * Read-only by design: this module never writes the YAML file.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default location of the shipped config: `runtime/decisions.yaml`
 * next to this module. Works both in the dev tree and inside the npm
 * tarball (package.json `files` ships the whole `runtime` directory).
 */
export const DEFAULT_DECISIONS_PATH = path.join(moduleDir, "decisions.yaml");

/* -------------------------------------------------------------------------- */
/* Closed sets (mirror of src/core/decisions.ts)                              */
/* -------------------------------------------------------------------------- */

export const READ_ONLY_ACTIONS = new Set([
    "freshness.skip",
    "triage.apply_label",
    "review-pr.merge_pr",
    "supervisor.retry",
    "operator.escalate",
]);

const ALLOWED_TIER_KEYS = new Set([
    "confidence_min",
    "confidence_max",
    "noul_yes_max",
    "noul_yes_min",
    "blocking_findings_max",
    "retryable_class_only",
    "target",
    "channel",
    "prompt",
]);

const ALLOWED_RULE_KEYS = new Set(["action", "auto", "confirm", "escalate"]);
const ALLOWED_TOP_KEYS = new Set(["version", "decisions", "composite", "fallback"]);
const ALLOWED_COMPOSITE_KEYS = new Set(["spec", "impl", "review", "verify"]);
const ALLOWED_FALLBACK_KEYS = new Set(["cjk"]);
const ALLOWED_CJK_KEYS = new Set(["trigger", "conditions", "fallback_backend", "log_warning"]);
const ALLOWED_CONFIDENCE_BELOW_KEYS = new Set(["action", "threshold"]);
const ALLOWED_CONDITION_KINDS = new Set([
    "typesafe_unreachable",
    "typesafe_status_5xx",
    "typesafe_confidence_below",
]);

/* -------------------------------------------------------------------------- */
/* Tiny YAML 1.2 subset parser (JS port of parseDecisionsYaml)                */
/* -------------------------------------------------------------------------- */

export function parseDecisionsYaml(raw) {
    const lines = stripCommentsAndBlank(raw);
    if (lines.length === 0) {
        throw new Error("decisions.yaml is empty");
    }
    const result = parseBlock(lines, 0, 0);
    if (result === undefined) {
        throw new Error("decisions.yaml: top-level block missing");
    }
    return result.value;
}

function parseBlock(lines, start, parentIndent) {
    let i = start;
    while (i < lines.length && lines[i].trim() === "") i += 1;
    if (i >= lines.length) return undefined;
    const headIndent = countLeadingSpaces(lines[i]);
    if (headIndent !== parentIndent) return undefined;
    if (lines[i].trimStart().startsWith("- ")) {
        return parseSequence(lines, i, parentIndent);
    }
    return parseMapping(lines, i, parentIndent);
}

function parseMapping(lines, start, parentIndent) {
    const out = {};
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "") { i += 1; continue; }
        const indent = countLeadingSpaces(line);
        if (indent !== parentIndent) break;
        if (trimmed.startsWith("- ")) break; // sequence begins
        const colon = trimmed.indexOf(":");
        if (colon === -1) {
            throw new Error(`decisions.yaml: expected "key: value" (got "${trimmed}")`);
        }
        const key = trimmed.slice(0, colon).trim();
        const rest = trimmed.slice(colon + 1).trim();
        if (rest === "") {
            const child = parseBlock(lines, i + 1, parentIndent + 2);
            if (child === undefined) {
                throw new Error(`decisions.yaml: key "${key}" has no value (line ${i + 1})`);
            }
            out[key] = child.value;
            i = child.nextCursor;
        } else if (rest.startsWith("{")) {
            out[key] = parseFlowMapping(rest);
            i += 1;
        } else if (rest.startsWith("[")) {
            out[key] = parseFlowSequence(rest);
            i += 1;
        } else {
            out[key] = parseScalar(rest);
            i += 1;
        }
    }
    return { value: out, nextCursor: i };
}

function parseSequence(lines, start, parentIndent) {
    const out = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "") { i += 1; continue; }
        const indent = countLeadingSpaces(line);
        if (indent !== parentIndent) break;
        if (!trimmed.startsWith("- ")) break;
        const afterDash = trimmed.slice(1).trimStart();
        if (afterDash === "") {
            const child = parseBlock(lines, i + 1, parentIndent + 4);
            if (child === undefined) {
                throw new Error(`decisions.yaml: empty sequence entry at line ${i + 1}`);
            }
            out.push(child.value);
            i = child.nextCursor;
            continue;
        }
        if (!containsTopLevelColon(afterDash)) {
            out.push(parseScalar(afterDash));
            i += 1;
            continue;
        }
        const entryIndent = parentIndent + 2;
        const entry = {};
        const colon = afterDash.indexOf(":");
        const headKey = afterDash.slice(0, colon).trim();
        const headRest = afterDash.slice(colon + 1).trim();
        if (headRest === "") {
            const child = parseBlock(lines, i + 1, entryIndent);
            if (child === undefined) {
                throw new Error(`decisions.yaml: empty child after "${headKey}:" (line ${i + 1})`);
            }
            entry[headKey] = child.value;
            i = child.nextCursor;
        } else if (headRest.startsWith("{")) {
            entry[headKey] = parseFlowMapping(headRest);
            i += 1;
            i = consumeSubRows(lines, i, entryIndent, entry);
        } else if (headRest.startsWith("[")) {
            entry[headKey] = parseFlowSequence(headRest);
            i += 1;
            i = consumeSubRows(lines, i, entryIndent, entry);
        } else {
            entry[headKey] = parseScalar(headRest);
            i += 1;
            i = consumeSubRows(lines, i, entryIndent, entry);
        }
        out.push(entry);
    }
    return { value: out, nextCursor: i };
}

function containsTopLevelColon(text) {
    let depth = 0;
    let braceDepth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble) {
            if (ch === "{") braceDepth += 1;
            else if (ch === "}") braceDepth -= 1;
            else if (ch === "[") depth += 1;
            else if (ch === "]") depth -= 1;
            else if (ch === ":" && braceDepth === 0 && depth === 0) return true;
        }
    }
    return false;
}

function consumeSubRows(lines, start, subIndent, entry) {
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "") { i += 1; continue; }
        const indent = countLeadingSpaces(line);
        if (indent !== subIndent) break;
        if (trimmed.startsWith("- ")) break;
        const colon = trimmed.indexOf(":");
        if (colon === -1) {
            throw new Error(`decisions.yaml: expected "key: value" (got "${trimmed}")`);
        }
        const key = trimmed.slice(0, colon).trim();
        const rest = trimmed.slice(colon + 1).trim();
        if (rest === "") {
            throw new Error(`decisions.yaml: multi-line children inside sequence entries are not supported (key "${key}")`);
        }
        if (rest.startsWith("{")) {
            entry[key] = parseFlowMapping(rest);
        } else if (rest.startsWith("[")) {
            entry[key] = parseFlowSequence(rest);
        } else {
            entry[key] = parseScalar(rest);
        }
        i += 1;
    }
    return i;
}

function stripCommentsAndBlank(raw) {
    const out = [];
    const rawLines = raw.split(/\r?\n/);
    for (const line of rawLines) {
        const stripped = stripComment(line);
        if (stripped.trim() === "") continue;
        out.push(stripped);
    }
    return out;
}

function stripComment(line) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
    }
    return line;
}

function countLeadingSpaces(line) {
    let n = 0;
    while (n < line.length && line[n] === " ") n += 1;
    return n;
}

export function parseScalar(raw) {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null" || trimmed === "~") return null;

    if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
        return trimmed.slice(1, -1);
    }

    if (/^-?\d+$/.test(trimmed)) {
        const n = Number.parseInt(trimmed, 10);
        if (Number.isFinite(n)) return n;
    }
    if (/^-?\d+\.\d+$/.test(trimmed)) {
        const n = Number.parseFloat(trimmed);
        if (Number.isFinite(n)) return n;
    }

    return trimmed;
}

export function parseFlowMapping(raw) {
    const body = stripFlowBraces(raw, "{", "}");
    const out = {};
    for (const part of splitFlow(body, ",")) {
        const seg = part.trim();
        if (seg === "") continue;
        const colon = seg.indexOf(":");
        if (colon === -1) {
            throw new Error(`decisions.yaml: malformed flow mapping segment "${seg}"`);
        }
        const key = seg.slice(0, colon).trim();
        const value = seg.slice(colon + 1).trim();
        if (value.startsWith("{")) {
            out[key] = parseFlowMapping(value);
        } else if (value.startsWith("[")) {
            out[key] = parseFlowSequence(value);
        } else {
            out[key] = parseScalar(value);
        }
    }
    return out;
}

export function parseFlowSequence(raw) {
    const body = stripFlowBraces(raw, "[", "]");
    const out = [];
    for (const part of splitFlow(body, ",")) {
        const seg = part.trim();
        if (seg === "") continue;
        if (seg.startsWith("{")) {
            out.push(parseFlowMapping(seg));
        } else if (seg.startsWith("[")) {
            out.push(parseFlowSequence(seg));
        } else {
            out.push(parseScalar(seg));
        }
    }
    return out;
}

function stripFlowBraces(raw, open, close) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) {
        throw new Error(`decisions.yaml: expected flow collection starting with "${open}" (got "${raw}")`);
    }
    return trimmed.slice(1, -1).trim();
}

function splitFlow(raw, separator) {
    const parts = [];
    let depth = 0;
    let braceDepth = 0;
    let inSingle = false;
    let inDouble = false;
    let start = 0;
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble) {
            if (ch === "{") braceDepth += 1;
            else if (ch === "}") braceDepth -= 1;
            else if (ch === "[") depth += 1;
            else if (ch === "]") depth -= 1;
            else if (ch === separator && braceDepth === 0 && depth === 0) {
                parts.push(raw.slice(start, i));
                start = i + 1;
            }
        }
    }
    parts.push(raw.slice(start));
    return parts;
}

/* -------------------------------------------------------------------------- */
/* Validator (JS port of validateDecisions)                                   */
/* -------------------------------------------------------------------------- */

export function validateDecisions(decisions) {
    const errors = [];

    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
        return { ok: false, errors: ["top-level must be a YAML mapping"] };
    }
    const root = decisions;

    for (const key of Object.keys(root)) {
        if (!ALLOWED_TOP_KEYS.has(key)) {
            errors.push(`unknown top-level key: ${key}`);
        }
    }

    if (root.version !== 1) {
        errors.push(`unsupported version: ${String(root.version)} (expected 1)`);
    }

    if (!Array.isArray(root.decisions)) {
        errors.push("`decisions` must be a list");
    } else {
        const seenActions = new Set();
        for (let i = 0; i < root.decisions.length; i += 1) {
            const entry = root.decisions[i];
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                errors.push(`decisions[${i}] must be a mapping`);
                continue;
            }
            const rule = entry;
            for (const key of Object.keys(rule)) {
                if (!ALLOWED_RULE_KEYS.has(key)) {
                    errors.push(`decisions[${i}]: unknown key "${key}"`);
                }
            }
            if (typeof rule.action !== "string" || rule.action === "") {
                errors.push(`decisions[${i}]: "action" must be a non-empty string`);
            } else if (!READ_ONLY_ACTIONS.has(rule.action)) {
                errors.push(`decisions[${i}]: action "${rule.action}" is not in READ_ONLY_ACTIONS`);
            } else if (seenActions.has(rule.action)) {
                errors.push(`decisions[${i}]: duplicate action "${rule.action}"`);
            } else {
                seenActions.add(rule.action);
            }
            validateTier("auto", rule.auto, errors, i);
            validateTier("confirm", rule.confirm, errors, i);
            validateTier("escalate", rule.escalate, errors, i);
            const minValues = collectConfidenceValues(rule, "confidence_min");
            const maxValues = collectConfidenceValues(rule, "confidence_max");
            if (minValues.length > 0 && maxValues.length > 0) {
                const min = Math.min(...minValues);
                const max = Math.max(...maxValues);
                if (min > max) {
                    errors.push(
                        `decisions[${i}] action "${rule.action}": confidence_min (${min}) > confidence_max (${max})`,
                    );
                }
            }
        }
    }

    if (!root.composite || typeof root.composite !== "object" || Array.isArray(root.composite)) {
        errors.push("`composite` must be a mapping");
    } else {
        const composite = root.composite;
        for (const key of Object.keys(composite)) {
            if (!ALLOWED_COMPOSITE_KEYS.has(key)) {
                errors.push(`composite: unknown key "${key}"`);
            }
        }
        const requiredKeys = ["spec", "impl", "review", "verify"];
        let sum = 0;
        for (const key of requiredKeys) {
            const v = composite[key];
            if (typeof v !== "number" || !Number.isFinite(v)) {
                errors.push(`composite.${key} must be a finite number (got ${String(v)})`);
                continue;
            }
            sum += v;
        }
        if (Math.abs(sum - 1.0) > 0.01) {
            errors.push(`composite weights sum to ${sum.toFixed(3)}, expected 1.0 ± 0.01`);
        }
    }

    if (!root.fallback || typeof root.fallback !== "object" || Array.isArray(root.fallback)) {
        errors.push("`fallback` must be a mapping");
    } else {
        const fb = root.fallback;
        for (const key of Object.keys(fb)) {
            if (!ALLOWED_FALLBACK_KEYS.has(key)) {
                errors.push(`fallback: unknown key "${key}"`);
            }
        }
        if (!fb.cjk || typeof fb.cjk !== "object" || Array.isArray(fb.cjk)) {
            errors.push("fallback.cjk must be a mapping");
        } else {
            const cjk = fb.cjk;
            for (const key of Object.keys(cjk)) {
                if (!ALLOWED_CJK_KEYS.has(key)) {
                    errors.push(`fallback.cjk: unknown key "${key}"`);
                }
            }
            if (cjk.trigger !== "any_of") {
                errors.push(`fallback.cjk.trigger must be "any_of" (got ${String(cjk.trigger)})`);
            }
            if (!Array.isArray(cjk.conditions)) {
                errors.push("fallback.cjk.conditions must be a list");
            } else {
                for (let i = 0; i < cjk.conditions.length; i += 1) {
                    validateCjkCondition(cjk.conditions[i], errors, i);
                }
            }
            if (typeof cjk.fallback_backend !== "string" || cjk.fallback_backend === "") {
                errors.push("fallback.cjk.fallback_backend must be a non-empty string");
            }
            if (typeof cjk.log_warning !== "string" || cjk.log_warning === "") {
                errors.push("fallback.cjk.log_warning must be a non-empty string");
            }
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true };
}

function validateTier(tierName, tier, errors, ruleIndex) {
    if (tier === undefined) return;
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
        errors.push(`decisions[${ruleIndex}].${tierName} must be a mapping`);
        return;
    }
    const t = tier;
    for (const key of Object.keys(t)) {
        if (!ALLOWED_TIER_KEYS.has(key)) {
            errors.push(`decisions[${ruleIndex}].${tierName}: unknown key "${key}"`);
        }
    }
    for (const numericKey of ["confidence_min", "confidence_max", "noul_yes_max", "noul_yes_min"]) {
        const v = t[numericKey];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
            errors.push(`decisions[${ruleIndex}].${tierName}.${numericKey} must be a number in [0.0, 1.0] (got ${String(v)})`);
        }
    }
    const bf = t.blocking_findings_max;
    if (bf !== undefined && (!Number.isInteger(bf) || bf < 0)) {
        errors.push(`decisions[${ruleIndex}].${tierName}.blocking_findings_max must be a non-negative integer (got ${String(bf)})`);
    }
    if (t.retryable_class_only !== undefined && typeof t.retryable_class_only !== "boolean") {
        errors.push(`decisions[${ruleIndex}].${tierName}.retryable_class_only must be a boolean`);
    }
}

function collectConfidenceValues(rule, key) {
    const out = [];
    for (const tierName of ["auto", "confirm", "escalate"]) {
        const tier = rule[tierName];
        if (!tier || typeof tier !== "object") continue;
        const v = tier[key];
        if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    }
    return out;
}

function validateCjkCondition(cond, errors, index) {
    if (typeof cond === "string") {
        if (!ALLOWED_CONDITION_KINDS.has(cond)) {
            errors.push(`fallback.cjk.conditions[${index}]: unknown condition "${cond}"`);
        }
        return;
    }
    if (!cond || typeof cond !== "object" || Array.isArray(cond)) {
        errors.push(`fallback.cjk.conditions[${index}] must be a string or a single-key mapping`);
        return;
    }
    const keys = Object.keys(cond);
    if (keys.length !== 1 || keys[0] !== "typesafe_confidence_below") {
        errors.push(`fallback.cjk.conditions[${index}]: only typesafe_confidence_below is allowed as a mapping condition`);
        return;
    }
    const inner = cond.typesafe_confidence_below;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
        errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below must be a mapping`);
        return;
    }
    for (const key of Object.keys(inner)) {
        if (!ALLOWED_CONFIDENCE_BELOW_KEYS.has(key)) {
            errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below: unknown key "${key}"`);
        }
    }
    if (typeof inner.action !== "string" || inner.action === "") {
        errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below.action must be a non-empty string`);
    }
    if (typeof inner.threshold !== "number" || !Number.isFinite(inner.threshold) || inner.threshold < 0 || inner.threshold > 1) {
        errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below.threshold must be a number in [0.0, 1.0] (got ${String(inner.threshold)})`);
    }
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read + parse + validate `decisions.yaml`, returning the JSON-ready
 * object served by `GET /api/decisions`:
 * `{ version, decisions: [...], composite: {...}, fallback: {...} }`.
 *
 * Throws `Error("Invalid decisions.yaml: ...")` on a missing file, a
 * parse failure, or a schema violation — callers (the panel API) catch
 * and render the message; the error never crashes the server.
 */
export async function loadDecisionsJson(filePath = DEFAULT_DECISIONS_PATH) {
    let parsed;
    let raw;
    try {
        raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
        const reason = String(error?.message ?? error);
        throw new Error(`Invalid decisions.yaml: cannot read ${filePath}: ${reason}`);
    }
    try {
        parsed = parseDecisionsYaml(raw);
    } catch (error) {
        const reason = String(error?.message ?? error);
        throw new Error(`Invalid decisions.yaml: ${reason}`);
    }
    const result = validateDecisions(parsed);
    if (!result.ok) {
        throw new Error(`Invalid decisions.yaml: ${result.errors.join("; ")}`);
    }
    return parsed;
}
