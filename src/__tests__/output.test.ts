import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonObject, stringList } from '../core/output.js';

test('JSON recovery keeps the complete outer object and quoted delimiters', () => {
  const value = { comment: 'A quoted brace } and escaped quote "', commands: [{ command: 'npm test' }] };
  assert.deepEqual(jsonObject(`Result follows:\n${JSON.stringify(value, null, 2)}\nDone.`), value);
});

test('string list recovery keeps array delimiters in wrapped output', () => {
  assert.deepEqual(stringList('Files: ["a.ts", "b]c.ts"]', 'files'), ['a.ts', 'b]c.ts']);
});

test('string list errors name the actual invalid entries and required response shape', () => {
  assert.throws(() => stringList(['valid', {id:'AC-2',text:'condition'}], 'product.acceptanceCriteria'),
    /product.acceptanceCriteria: expected an array of strings, received array with non-string entries at indexes 1/);
  assert.throws(() => stringList(undefined, 'tech.openQuestions'), /received undefined/);
});
