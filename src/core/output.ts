/**
 * Parse one complete JSON document from an LLM response.
 *
 * LLMs in the wild reliably produce non-JSON-shaped outputs:
 *   - wrap the value in ```json fences
 *   - prepend prose ("Confirmed:", "Sure, here's the result:")
 *   - drop a JSON line in the middle of a markdown explanation
 *   - produce pure prose with no JSON at all
 *
 * We try multiple recovery strategies so a single noisy line doesn't
 * kill an otherwise fine agent run. The strategies, in order:
 *
 *   1. Direct JSON.parse of the trimmed text.
 *   2. Strip ```json ... ``` fences and retry.
 *   3. Find the first balanced {...} block (quote-aware) and parse it.
 *   4. Find the first balanced {...} block after stripping a known set
 *      of prose prefixes that LLMs love to prepend.
 *   5. Find a JSON-looking line (starts with `{` or `[`) and parse it.
 *
 * If every strategy fails, throw with the truncated text so the caller
 * can either retry the LLM with a stricter prompt or fall back to a
 * deterministic local heuristic.
 */
export function jsonObject(text: string): Record<string, any> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("LLM returned an empty response");

  // 1. Direct parse (best case).
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  // 2. Strip ```json / ``` fences.
  const fenced = trimmed
    .replace(/^```(?:json|js|javascript)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  const fromFence = tryParseObject(fenced);
  if (fromFence) return fromFence;

  // 3. First balanced {...} block.
  const balanced = extractJsonBlock(trimmed, "{", "}");
  if (balanced) {
    const parsed = tryParseObject(balanced);
    if (parsed) return parsed;
  }

  // 4. Strip a known prose prefix, then re-extract.
  const stripped = stripProsePrefix(trimmed);
  if (stripped !== trimmed) {
    const balancedAfterStrip = extractJsonBlock(stripped, "{", "}");
    if (balancedAfterStrip) {
      const parsed = tryParseObject(balancedAfterStrip);
      if (parsed) return parsed;
    }
    const fromStrippedFence = tryParseObject(stripped.replace(/^```(?:json|js|javascript)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim());
    if (fromStrippedFence) return fromStrippedFence;
  }

  // 5. First line that begins with `{` or `[`.
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    const parsed = tryParseObject(t);
    if (parsed) return parsed;
  }

  throw new Error(`Could not parse JSON from model output: ${truncate(trimmed)}`);
}

/** Parse a list of strings, recovering a JSON array if the LLM wrapped prose. */
export function stringList(value: unknown, name: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "string") {
    const extracted = extractJsonBlock(value, "[", "]");
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
      } catch {}
    }
  }
  throw new Error(`Invalid ${name}`);
}

function tryParseObject(text: string): Record<string, any> | null {
  try {
    const value = JSON.parse(text);
    return validateObject(value);
  } catch {
    return null;
  }
}

function validateObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, any>;
}

/**
 * Strip the leading prose patterns that LLMs prepend before the real
 * JSON. We only strip the first line; if the JSON sits further down,
 * extractJsonBlock finds it.
 */
function stripProsePrefix(text: string): string {
  const prefixes = [
    /^(?:sure|ok|okay|alright|certainly|absolutely|of course)[,!.]?\s*/i,
    /^(?:confirmed|confirming)[,!.]?\s*/i,
    /^(?:here(?:'s| is) (?:the|my) (?:result|answer|response|json|output|decision|analysis|triage)[,!.:]?)\s*/i,
    /^(?:the (?:result|answer|response|json|output|decision|analysis|triage) (?:is|:))\s*/i,
    /^(?:final (?:result|answer|response|json|output|decision|analysis|triage)[,!.:]?)\s*/i,
    /^(?:based on (?:my|the) (?:analysis|review|inspection)[,!.:]?)\s*/i,
    /^```(?:json)?\s*\n?/i,
  ];
  let current = text;
  let changed = false;
  for (const pattern of prefixes) {
    const next = current.replace(pattern, "");
    if (next !== current) {
      current = next;
      changed = true;
    }
  }
  return changed ? current.trimStart() : text;
}

/**
 * Find the first balanced JSON block delimited by `open`/`close` while
 * respecting quoted strings and backslash escapes. Returns the substring
 * (without the surrounding delimiters), or null if no balanced block
 * exists. This lets us salvage an LLM response that said something like
 * "Confirmed: {...} let me know if you need more".
 */
function extractJsonBlock(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

function truncate(text: string, max = 240): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
