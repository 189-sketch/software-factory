import test from 'node:test';
import assert from 'node:assert/strict';
import { collectText } from '../core/harness.js';

/**
 * The lifecycle observer (added to HarnessLlmEngine.start) projects
 * model message buffers into log lines. The text extraction must handle
 * three shapes:
 *   1. plain string content (legacy / direct prompts)
 *   2. array of text parts (Anthropic structured content)
 *   3. anything else (tool calls, image parts) → empty string
 */
test('collectText returns the raw string for plain string content', () => {
    assert.equal(collectText("hello world"), "hello world");
});

test('collectText concatenates text parts in structured content', () => {
    assert.equal(
        collectText([
            { type: "text", text: "first " },
            { type: "text", text: "second" },
        ]),
        "first second",
    );
});

test('collectText skips non-text parts (tool_use, image)', () => {
    assert.equal(
        collectText([
            { type: "text", text: "before " },
            { type: "tool_use", id: "x", name: "y", input: {} },
            { type: "text", text: "after" },
        ]),
        "before after",
    );
});

test('collectText returns empty string for unknown shapes', () => {
    assert.equal(collectText(null), "");
    assert.equal(collectText(undefined), "");
    assert.equal(collectText(42), "");
    assert.equal(collectText({}), "");
    assert.equal(collectText([{ type: "image", source: {} }]), "");
});
