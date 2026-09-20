/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.3.
 *
 * `runtime/decisions.yaml` loader + schema validator + startup pre-check.
 *
 * The orchestrator reads the per-action confidence / freshness threshold
 * table from `runtime/decisions.yaml` instead of hard-coded `if/else`
 * branches (Decision 5). This module is the only place that knows how to
 * parse the file; callers either invoke `loadDecisions()` to get the
 * parsed shape, `validateDecisions(decisions)` to assert the file is
 * schema-compliant, or `runDecisionsPreCheck()` to mirror the F01
 * `load_skill` regression severity: a bad file is a startup failure, not
 * a silent default.
 *
 * Scope (additive helper only):
 * - This module is purely additive. No existing caller is modified.
 * - `js-yaml` is NOT a dependency; we parse the small YAML 1.2 subset
 *   the spec mandates with a tiny in-tree parser. Adding a dependency
 *   just for this 15-line schema would inflate the install surface for
 *   no benefit.
 * - `READ_ONLY_ACTIONS` is the closed set defined by the orchestrator
 *   per `requirements.md` §"`decisions.yaml` Schema` §"Schema validation
 *   rules". New actions require a schema migration (a code edit to this
 *   file plus a paired test that fails when the YAML key disappears).
 */
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Closed set of actions the orchestrator recognises                          */
/* -------------------------------------------------------------------------- */

/**
 * Closed `READ_ONLY_ACTIONS` set — every action referenced in
 * `decisions.yaml` MUST appear here. Adding a new action requires a
 * schema migration: extend this list, ship the YAML row, and add a
 * paired test asserting the YAML key still resolves to a member of
 * this set.
 *
 * The five actions below are the example rows from
 * `requirements.md` §"`decisions.yaml` Schema" lines 316-339.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set<string>([
    "freshness.skip",
    "triage.apply_label",
    "review-pr.merge_pr",
    "supervisor.retry",
    "operator.escalate",
]);

/* -------------------------------------------------------------------------- */
/* Type surface (verbatim from requirements.md §"`decisions.yaml` Schema)    */
/* -------------------------------------------------------------------------- */

/** Threshold rule for one tier (auto / confirm / escalate) of an action. */
export interface DecisionTierRule {
    /** Lower bound on the model's confidence; auto/confirm fires when `confidence >= confidence_min`. */
    confidence_min?: number;
    /** Upper bound on the model's confidence; escalate fires when `confidence <= confidence_max`. */
    confidence_max?: number;
    /** Freshness `Noul` ceiling — auto fires when `noul_yes <= noul_yes_max`. */
    noul_yes_max?: number;
    /** Freshness `Noul` floor — escalate fires when `noul_yes >= noul_yes_min`. */
    noul_yes_min?: number;
    /** Number of blocking findings tolerated by an auto-merge (review-pr only). */
    blocking_findings_max?: number;
    /** Restrict auto-retry to retryable failure classes (supervisor.retry only). */
    retryable_class_only?: boolean;
    /** Routing target label when the tier fires (`needs-info`, `human`, `log_only`, ...). */
    target?: string;
    /** Operator channel for the dashboard / pager tier. */
    channel?: string;
    /** Prompt template shown to the operator on a confirm tier. */
    prompt?: string;
}

/** Per-action routing rule. At least one of `auto` / `confirm` / `escalate` is required. */
export interface DecisionRule {
    /** Action key; MUST be a member of `READ_ONLY_ACTIONS`. */
    action: string;
    auto?: DecisionTierRule;
    confirm?: DecisionTierRule;
    escalate?: DecisionTierRule;
}

/** Weight per dimension of the composite rubric (Decision 6). */
export interface CompositeWeights {
    spec: number;
    impl: number;
    review: number;
    verify: number;
}

/** One condition in the CJK fallback block. */
export type CjkFallbackCondition =
    | "typesafe_unreachable"
    | "typesafe_status_5xx"
    | { typesafe_confidence_below: { action: string; threshold: number } };

/** CJK fallback block (Decision 7). */
export interface CjkFallbackBlock {
    trigger: "any_of";
    conditions: CjkFallbackCondition[];
    fallback_backend: string;
    log_warning: string;
}

/** Top-level `fallback:` block. */
export interface FallbackBlock {
    cjk: CjkFallbackBlock;
}

/** Parsed `decisions.yaml`. */
export interface DecisionsFile {
    version: number;
    decisions: DecisionRule[];
    composite: CompositeWeights;
    fallback: FallbackBlock;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Path relative to `process.cwd()`; matches the install layout `runtime/` ships. */
export const DEFAULT_DECISIONS_PATH = path.resolve("runtime", "decisions.yaml");

/** Allowed keys at the decision tier level (closed set for "unknown keys fail startup" rule). */
const ALLOWED_TIER_KEYS = new Set<string>([
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

/** Allowed keys at the decision rule level. */
const ALLOWED_RULE_KEYS = new Set<string>(["action", "auto", "confirm", "escalate"]);

/** Allowed keys at the top level. */
const ALLOWED_TOP_KEYS = new Set<string>(["version", "decisions", "composite", "fallback"]);

/** Allowed keys at the composite level. */
const ALLOWED_COMPOSITE_KEYS = new Set<string>(["spec", "impl", "review", "verify"]);

/** Allowed keys at the fallback level. */
const ALLOWED_FALLBACK_KEYS = new Set<string>(["cjk"]);

/** Allowed keys inside a fallback.cjk block. */
const ALLOWED_CJK_KEYS = new Set<string>(["trigger", "conditions", "fallback_backend", "log_warning"]);

/** Allowed keys inside the { typesafe_confidence_below: ... } condition. */
const ALLOWED_CONFIDENCE_BELOW_KEYS = new Set<string>(["action", "threshold"]);

/** Allowed condition kinds inside `cjk.conditions[]`. */
const ALLOWED_CONDITION_KINDS = new Set<string>([
    "typesafe_unreachable",
    "typesafe_status_5xx",
    "typesafe_confidence_below",
]);

/* -------------------------------------------------------------------------- */
/* Tiny YAML 1.2 subset parser                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal YAML 1.2 parser covering exactly the subset the spec
 * mandates:
 * - top-level `key: value` pairs (value can be a scalar, flow mapping
 *   `{ k: v, k2: v2 }`, or flow sequence `[ a, b, c ]`);
 * - sequences of mappings (`- action: foo` + sub `key: value` pairs)
 *   for the `decisions:` and `conditions:` blocks;
 * - `# comments` and blank lines.
 *
 * Anything outside this subset throws. Adding `js-yaml` would inflate
 * the install surface for a 15-line schema, so we keep the parser in
 * tree and document the subset explicitly.
 */
export function parseDecisionsYaml(raw: string): unknown {
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

/**
 * Parse a YAML block (a list of `key: value` rows) starting at `start`.
 * `parentIndent` is the indent of the surrounding scope. Returns both
 * the parsed value and the next cursor position so the caller knows
 * where to resume.
 *
 * The parser is hand-rolled to cover exactly the subset the schema
 * needs; it does NOT support block mappings (the spec uses flow
 * mappings everywhere), anchors, tags, multi-line scalars, or
 * document separators.
 */
function parseBlock(lines: string[], start: number, parentIndent: number): { value: unknown; nextCursor: number } | undefined {
    // First row decides the shape: if it starts with `-`, the block is
    // a sequence; otherwise it is a mapping.
    let i = start;
    // Skip blank / pure-comment lines that may have slipped through.
    while (i < lines.length && lines[i].trim() === "") i += 1;
    if (i >= lines.length) return undefined;
    const headIndent = countLeadingSpaces(lines[i]);
    if (headIndent !== parentIndent) return undefined;
    if (lines[i].trimStart().startsWith("- ")) {
        return parseSequence(lines, i, parentIndent);
    }
    return parseMapping(lines, i, parentIndent);
}

function parseMapping(lines: string[], start: number, parentIndent: number): { value: Record<string, unknown>; nextCursor: number } {
    const out: Record<string, unknown> = {};
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
            // Multi-line child at the next indent.
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

function parseSequence(lines: string[], start: number, parentIndent: number): { value: unknown[]; nextCursor: number } {
    const out: unknown[] = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "") { i += 1; continue; }
        const indent = countLeadingSpaces(line);
        if (indent !== parentIndent) break;
        if (!trimmed.startsWith("- ")) break;
        // Everything after the `-` is the first "row" of the entry.
        const afterDash = trimmed.slice(1).trimStart();
        if (afterDash === "") {
            // `-` followed by an indented child block on subsequent lines.
            const child = parseBlock(lines, i + 1, parentIndent + 4);
            if (child === undefined) {
                throw new Error(`decisions.yaml: empty sequence entry at line ${i + 1}`);
            }
            out.push(child.value);
            i = child.nextCursor;
            continue;
        }
        // The first row after `-` is one of:
        //   - a plain scalar (sequence of strings, e.g. CJK conditions);
        //   - a flow mapping (`{ k: v }`);
        //   - a `key: value` mapping row that may be followed by sub-rows.
        //
        // A row like `- typesafe_unreachable` is a bare scalar — emit
        // it as-is and move on. We detect "scalar" by the absence of
        // a `:` separator that isn't inside braces.
        if (!containsTopLevelColon(afterDash)) {
            out.push(parseScalar(afterDash));
            i += 1;
            continue;
        }
        const entryIndent = parentIndent + 2;
        const entry: Record<string, unknown> = {};
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

/**
 * True when `text` contains a `:` at the top level (not inside a flow
 * mapping / sequence). Used to distinguish bare-scalar sequence
 * entries (`- typesafe_unreachable`) from mapping entries
 * (`- typesafe_confidence_below: { ... }`).
 */
function containsTopLevelColon(text: string): boolean {
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

/**
 * After consuming the head row, drain any number of `key: value` rows
 * at `subIndent` into `entry`. Returns the next line index at the
 * outer `parentIndent`.
 */
function consumeSubRows(lines: string[], start: number, subIndent: number, entry: Record<string, unknown>): number {
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
            // Skip multi-line children inside a sequence entry; the
            // schema does not use them.
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

/**
 * Find the next non-blank line whose indent equals `targetIndent`,
 * starting at `start`. Used to resume after consuming a child block
 * whose depth differs from the parent. If no line at the target indent
 * exists, returns `lines.length` (end of input) — the caller decides
 * whether end-of-input is a valid stopping position.
 */
function nextAtIndent(lines: string[], start: number, targetIndent: number): number {
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "") { i += 1; continue; }
        const indent = countLeadingSpaces(line);
        if (indent === targetIndent) return i;
        if (indent < targetIndent) return i;
        // A deeper indent means the parser was called with the wrong
        // parent indent; surface that.
        throw new Error(`decisions.yaml: unexpected indent at line ${i + 1}`);
    }
    return i;
}

function stripCommentsAndBlank(raw: string): string[] {
    const out: string[] = [];
    const rawLines = raw.split(/\r?\n/);
    for (const line of rawLines) {
        const stripped = stripComment(line);
        if (stripped.trim() === "") continue;
        out.push(stripped);
    }
    return out;
}

function stripComment(line: string): string {
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

function countLeadingSpaces(line: string): number {
    let n = 0;
    while (n < line.length && line[n] === " ") n += 1;
    return n;
}

/* -------------------------------------------------------------------------- */
/* Scalar / flow mapping / flow sequence parsers (testable in isolation)      */
/* -------------------------------------------------------------------------- */

export function parseScalar(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null" || trimmed === "~") return null;

    // Quoted strings — single or double quotes (no escape semantics).
    if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
        return trimmed.slice(1, -1);
    }

    // Numbers — int or float (negative, decimal).
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

/**
 * Parse a YAML flow mapping `{ k: v, k2: v2 }`. Keys are strings;
 * values flow through `parseScalar` so the values stay uniform with
 * the block parser. Nested flow mappings (`{ a: { b: 1 } }`) recurse.
 * Flow sequences inside the mapping (`{ a: [1, 2] }`) also recurse.
 */
export function parseFlowMapping(raw: string): Record<string, unknown> {
    const body = stripFlowBraces(raw, "{", "}");
    const out: Record<string, unknown> = {};
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

/**
 * Parse a YAML flow sequence `[ a, b, c ]`. Values flow through
 * `parseScalar`. Nested flow sequences / mappings recurse.
 */
export function parseFlowSequence(raw: string): unknown[] {
    const body = stripFlowBraces(raw, "[", "]");
    const out: unknown[] = [];
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

function stripFlowBraces(raw: string, open: string, close: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) {
        throw new Error(`decisions.yaml: expected flow collection starting with "${open}" (got "${raw}")`);
    }
    return trimmed.slice(1, -1).trim();
}

/**
 * Split a flow collection body on the top-level `separator` character.
 * Nested `{ ... }` and `[ ... ]` are treated as opaque groups so the
 * outer split ignores commas inside them.
 */
function splitFlow(raw: string, separator: string): string[] {
    const parts: string[] = [];
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
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read and parse `decisions.yaml` from `path` (default:
 * `runtime/decisions.yaml` relative to `process.cwd()`).
 *
 * Returns the parsed shape typed as `DecisionsFile`; the file is NOT
 * validated against the schema here. Callers that want schema validation
 * pipe the result through `validateDecisions(decisions)`. The
 * `runDecisionsPreCheck()` helper bundles both for the startup path.
 */
export async function loadDecisions(filePath: string = DEFAULT_DECISIONS_PATH): Promise<DecisionsFile> {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = parseDecisionsYaml(raw);
    return parsed as DecisionsFile;
}

/**
 * Synchronous counterpart to `loadDecisions`. Reads with
 * `fs.readFileSync` so callers (notably the `FactoryOrchestrator`
 * constructor) can wire the pre-check into the synchronous startup
 * path.
 */
export function loadDecisionsSync(filePath: string = DEFAULT_DECISIONS_PATH): DecisionsFile {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const parsed = parseDecisionsYaml(raw);
    return parsed as DecisionsFile;
}

/* -------------------------------------------------------------------------- */
/* Validator                                                                  */
/* -------------------------------------------------------------------------- */

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate a parsed `DecisionsFile` against the four schema rules
 * defined in `requirements.md` §"`decisions.yaml` Schema` §"Schema
 * validation rules":
 *
 * 1. Every `action` MUST appear in `READ_ONLY_ACTIONS`.
 * 2. `confidence_min` MUST be `<=` `confidence_max` per action.
 * 3. `composite.*` weights MUST sum to 1.0 within `±0.01`.
 * 4. Unknown keys at any level fail the startup pre-check.
 *
 * Returns `{ ok: true }` on success, `{ ok: false; errors }` with one
 * entry per failed rule otherwise. The errors are intended to be
 * human-readable: each one ends with the offending key / value so the
 * operator can fix the file without re-reading the spec.
 */
export function validateDecisions(decisions: unknown): ValidationResult {
    const errors: string[] = [];

    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
        return { ok: false, errors: ["top-level must be a YAML mapping"] };
    }
    const root = decisions as Record<string, unknown>;

    // Rule 4 (top-level unknown keys).
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
        const seenActions = new Set<string>();
        for (let i = 0; i < root.decisions.length; i += 1) {
            const entry = root.decisions[i];
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                errors.push(`decisions[${i}] must be a mapping`);
                continue;
            }
            const rule = entry as Record<string, unknown>;
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
            // Rule 2: confidence_min <= confidence_max when both present
            // on the same action (across all three tiers).
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

    // Rule 3: composite weights sum to 1.0 ± 0.01.
    if (!root.composite || typeof root.composite !== "object" || Array.isArray(root.composite)) {
        errors.push("`composite` must be a mapping");
    } else {
        const composite = root.composite as Record<string, unknown>;
        for (const key of Object.keys(composite)) {
            if (!ALLOWED_COMPOSITE_KEYS.has(key)) {
                errors.push(`composite: unknown key "${key}"`);
            }
        }
        const requiredKeys = ["spec", "impl", "review", "verify"] as const;
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
        const fb = root.fallback as Record<string, unknown>;
        for (const key of Object.keys(fb)) {
            if (!ALLOWED_FALLBACK_KEYS.has(key)) {
                errors.push(`fallback: unknown key "${key}"`);
            }
        }
        if (!fb.cjk || typeof fb.cjk !== "object" || Array.isArray(fb.cjk)) {
            errors.push("fallback.cjk must be a mapping");
        } else {
            const cjk = fb.cjk as Record<string, unknown>;
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

function validateTier(
    tierName: string,
    tier: unknown,
    errors: string[],
    ruleIndex: number,
): void {
    if (tier === undefined) return;
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
        errors.push(`decisions[${ruleIndex}].${tierName} must be a mapping`);
        return;
    }
    const t = tier as Record<string, unknown>;
    for (const key of Object.keys(t)) {
        if (!ALLOWED_TIER_KEYS.has(key)) {
            errors.push(`decisions[${ruleIndex}].${tierName}: unknown key "${key}"`);
        }
    }
    for (const numericKey of ["confidence_min", "confidence_max", "noul_yes_max", "noul_yes_min"] as const) {
        const v = t[numericKey];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
            errors.push(`decisions[${ruleIndex}].${tierName}.${numericKey} must be a number in [0.0, 1.0] (got ${String(v)})`);
        }
    }
    const bf = t.blocking_findings_max;
    if (bf !== undefined && (!Number.isInteger(bf) || (bf as number) < 0)) {
        errors.push(`decisions[${ruleIndex}].${tierName}.blocking_findings_max must be a non-negative integer (got ${String(bf)})`);
    }
    if (t.retryable_class_only !== undefined && typeof t.retryable_class_only !== "boolean") {
        errors.push(`decisions[${ruleIndex}].${tierName}.retryable_class_only must be a boolean`);
    }
}

function collectConfidenceValues(rule: Record<string, unknown>, key: "confidence_min" | "confidence_max"): number[] {
    const out: number[] = [];
    for (const tierName of ["auto", "confirm", "escalate"] as const) {
        const tier = rule[tierName];
        if (!tier || typeof tier !== "object") continue;
        const v = (tier as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    }
    return out;
}

function validateCjkCondition(cond: unknown, errors: string[], index: number): void {
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
    const keys = Object.keys(cond as Record<string, unknown>);
    if (keys.length !== 1 || keys[0] !== "typesafe_confidence_below") {
        errors.push(`fallback.cjk.conditions[${index}]: only typesafe_confidence_below is allowed as a mapping condition`);
        return;
    }
    const inner = (cond as Record<string, unknown>).typesafe_confidence_below;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
        errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below must be a mapping`);
        return;
    }
    const innerObj = inner as Record<string, unknown>;
    for (const key of Object.keys(innerObj)) {
        if (!ALLOWED_CONFIDENCE_BELOW_KEYS.has(key)) {
            errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below: unknown key "${key}"`);
        }
    }
    if (typeof innerObj.action !== "string" || innerObj.action === "") {
        errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below.action must be a non-empty string`);
    }
    if (typeof innerObj.threshold !== "number" || !Number.isFinite(innerObj.threshold) || (innerObj.threshold as number) < 0 || (innerObj.threshold as number) > 1) {
        errors.push(`fallback.cjk.conditions[${index}].typesafe_confidence_below.threshold must be a number in [0.0, 1.0] (got ${String(innerObj.threshold)})`);
    }
}

/* -------------------------------------------------------------------------- */
/* Startup pre-check                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run the `decisions.yaml` startup pre-check.
 *
 * Mirrors the F01 `load_skill` regression severity: a missing or
 * schema-invalid file aborts startup with an `Error` whose message
 * starts with `Invalid decisions.yaml:`, exactly the shape used by
 * `runtime/agent-backends.mjs::resolveAgentConfig` (`Invalid
 * FACTORY_AGENT backend: ...`, `Invalid FACTORY_AGENT_OVERRIDES: ...`).
 * The orchestrator should call this from its constructor — see the
 * inline note in `src/orchestrator/index.ts`.
 *
 * The function accepts an optional `path` override so unit tests can
 * point it at a fixture file. Production callers omit the argument and
 * read the default `runtime/decisions.yaml` next to the working
 * directory.
 *
 * On success, the parsed decisions are returned (typed) so callers can
 * stash them on the orchestrator instance without re-parsing.
 */
export async function runDecisionsPreCheck(filePath: string = DEFAULT_DECISIONS_PATH): Promise<DecisionsFile> {
    let parsed: DecisionsFile;
    try {
        parsed = await loadDecisions(filePath);
    } catch (error) {
        const reason = String((error as Error).message ?? error);
        throw new Error(`Invalid decisions.yaml: cannot read ${filePath}: ${reason}`);
    }
    const result = validateDecisions(parsed);
    if (!result.ok) {
        const summary = result.errors.join("; ");
        throw new Error(`Invalid decisions.yaml: ${summary}`);
    }
    return parsed;
}

/**
 * Synchronous counterpart to `runDecisionsPreCheck`. Mirrors the same
 * F01-style `Invalid decisions.yaml:` throw shape; suitable for the
 * `FactoryOrchestrator` constructor where the constructor body is
 * sync and we want the failure to surface at startup rather than at
 * the first `runForIssue()` call.
 *
 * The async helper remains the canonical entry point for tests and
 * for any caller that already has an async setup hook; this sync
 * helper is the orchestrator-specific companion.
 */
export function runDecisionsPreCheckSync(filePath: string = DEFAULT_DECISIONS_PATH): DecisionsFile {
    let parsed: DecisionsFile;
    try {
        parsed = loadDecisionsSync(filePath);
    } catch (error) {
        const reason = String((error as Error).message ?? error);
        throw new Error(`Invalid decisions.yaml: cannot read ${filePath}: ${reason}`);
    }
    const result = validateDecisions(parsed);
    if (!result.ok) {
        const summary = result.errors.join("; ");
        throw new Error(`Invalid decisions.yaml: ${summary}`);
    }
    return parsed;
}