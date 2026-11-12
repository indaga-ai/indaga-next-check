// The made-up cases and what leaves the page: facts numbered in order with a source each, the fields the rules
// read pointing at real facts, and a request that carries the facts and nothing else (no title, label or expected
// path that could steer the model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES, caseById } from '../src/cases/cases.mjs';
import { userMessage, MAX_USER_BYTES } from '../src/ai/prompt.mjs';

test('each case: a unique id, facts numbered 1 to N with text and a source, and pointers to real facts', () => {
  assert.deepEqual(CASES.map((c) => c.id), ['A', 'B', 'C', 'D']);
  for (const c of CASES) {
    assert.deepEqual(c.facts.map((f) => f.n), c.facts.map((_, i) => i + 1), c.id);
    for (const f of c.facts) assert.ok(f.text.trim() && f.source.trim(), `${c.id}.${f.n}`);
    const n = c.facts.length;
    for (const p of [c.stable?.fact, c.observations?.fact].filter((x) => x !== undefined)) assert.ok(Number.isInteger(p) && p >= 1 && p <= n, `${c.id} points at fact ${p}`);
    assert.ok(['lead', 'insufficient', 'urgent'].includes(c.expect), c.id);
  }
  assert.equal(caseById('a'), caseById('A'));
  assert.equal(caseById('Z'), null);
});

test('the three paths are all there', () => {
  assert.deepEqual([...new Set(CASES.map((c) => c.expect))].sort(), ['insufficient', 'lead', 'urgent']);
});

test('the request carries each fact and its source, and nothing that labels the case', () => {
  for (const c of CASES) {
    const m = userMessage(c);
    const lines = m.split('\n');
    assert.equal(lines[0], 'Facts:');
    assert.deepEqual(lines.slice(1).map((l) => JSON.parse(l)), c.facts.map((f) => ({ n: f.n, fact: f.text, source: f.source })));
    for (const label of [c.title, c.shows, `"${c.expect}"`, 'expect', 'shows']) assert.ok(!m.includes(label), `${c.id} leaks "${label}"`);
    assert.ok(new TextEncoder().encode(m).length < MAX_USER_BYTES, c.id);
  }
});
