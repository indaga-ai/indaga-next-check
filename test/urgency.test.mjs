// The urgency rules that run before any AI step: NEWS2's published bands and thresholds, the lab's own critical
// flag, and when a case is held for a person. The bands are from the Royal College of Physicians' NEWS2 chart 1 and
// the thresholds from chart 2 (2017), checked against the published charts on 12 Nov 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { news2Points, scoreNews2, news2Response, assessUrgency } from '../src/triage/urgency.mjs';
import { CASES, caseById } from '../src/cases/cases.mjs';

test('NEWS2 chart 1: every band edge scores as printed', () => {
  const edges = {
    respiratoryRate: [[8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3]],
    spo2: [[91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0], [100, 0]],
    systolic: [[90, 3], [91, 2], [100, 2], [101, 1], [110, 1], [111, 0], [219, 0], [220, 3]],
    pulse: [[40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3]],
    temperature: [[35.0, 3], [35.1, 1], [36.0, 1], [36.1, 0], [38.0, 0], [38.1, 1], [39.0, 1], [39.1, 2]],
  };
  for (const [name, rows] of Object.entries(edges)) {
    for (const [value, points] of rows) assert.equal(news2Points(name, value), points, `${name} ${value}`);
  }
  assert.equal(news2Points('pulse', undefined), null);
  assert.equal(news2Points('pulse', Number.NaN), null);
});

const calm = { respiratoryRate: 16, spo2: 97, onOxygen: false, systolic: 125, pulse: 70, consciousness: 'alert', temperature: 36.8 };

test('NEWS2: oxygen scores 2, anything but alert scores 3, and a missing parameter leaves the score incomplete', () => {
  assert.equal(scoreNews2(calm).total, 0);
  assert.equal(scoreNews2(calm).complete, true);
  assert.equal(scoreNews2({ ...calm, onOxygen: true }).total, 2);
  for (const c of ['new confusion', 'voice', 'pain', 'unresponsive']) assert.equal(scoreNews2({ ...calm, consciousness: c }).total, 3, c);
  const partial = scoreNews2({ ...calm, temperature: undefined });
  assert.equal(partial.complete, false);
  assert.equal(scoreNews2({ ...calm, consciousness: 'drowsy' }).complete, false, 'an unknown level is not scored as alert');
});

test('NEWS2 chart 2: the totals and the red score map to the published responses', () => {
  assert.equal(news2Response(0, false).risk, 'low');
  assert.equal(news2Response(4, false).risk, 'low');
  assert.equal(news2Response(3, true).risk, 'low–medium');
  assert.equal(news2Response(5, false).risk, 'medium');
  assert.equal(news2Response(6, true).risk, 'medium');
  assert.equal(news2Response(7, false).risk, 'high');
  assert.match(news2Response(7, false).response, /emergency/);
});

const adult = (over = {}) => ({ patient: { age: 40 }, stable: null, observations: { ...calm, fact: 2 }, facts: [{ n: 1, text: 'x', source: 's' }, { n: 2, text: 'y', source: 's' }], ...over });

test('an adult: a red score alone, or a total of 5, stops the case; a complete low score clears it', () => {
  assert.equal(assessUrgency(adult()).status, 'clear');
  const red = assessUrgency(adult({ observations: { ...calm, spo2: 90, fact: 2 } }));
  assert.equal(red.status, 'urgent');
  assert.equal(red.reasons[0].fact, 2);
  const five = assessUrgency(adult({ observations: { ...calm, respiratoryRate: 22, pulse: 115, temperature: 38.5, fact: 2 } }));
  assert.equal(five.news2.total, 5);
  assert.equal(five.news2.red, false);
  assert.equal(five.status, 'urgent');
  assert.equal(assessUrgency(adult({ observations: { ...calm, respiratoryRate: 22, pulse: 95, fact: 2 } })).status, 'clear', 'a total of 3 with no red score');
});

test('a red score counts even when the set is incomplete, but an incomplete low score clears nothing', () => {
  assert.equal(assessUrgency(adult({ observations: { consciousness: 'pain', fact: 2 } })).status, 'urgent');
  assert.equal(assessUrgency(adult({ observations: { ...calm, systolic: undefined, fact: 2 } })).status, 'hold');
  assert.equal(assessUrgency(adult({ observations: { ...calm, systolic: undefined, fact: 2 }, stable: { by: 'the clinic nurse', fact: 1 } })).status, 'clear');
});

test('the lab\'s own critical flag stops the case, whatever the observations and confirmations say', () => {
  const c = adult({ stable: { by: 'the clinic nurse', fact: 1 }, facts: [{ n: 1, text: 'x', source: 's' }, { n: 2, text: 'y', source: 's', critical: true }] });
  const r = assessUrgency(c);
  assert.equal(r.status, 'urgent');
  assert.deepEqual(r.reasons.map((x) => x.fact), [2]);
});

test('a child is not scored with NEWS2: held unless a clinician confirmed the child is not acutely unwell', () => {
  const child = { patient: { age: 9 }, stable: null, observations: { ...calm, spo2: 85, fact: 1 }, facts: [{ n: 1, text: 'x', source: 's' }] };
  const r = assessUrgency(child);
  assert.equal(r.news2, null, 'the adult score is not applied to a child');
  assert.equal(r.status, 'hold');
  assert.equal(assessUrgency({ ...child, stable: { by: 'her paediatrician', fact: 1 } }).status, 'clear');
});

test('the four made-up cases: D stops, A, B and C may be written up', () => {
  assert.equal(assessUrgency(caseById('D')).status, 'urgent');
  for (const id of ['A', 'B', 'C']) assert.equal(assessUrgency(caseById(id)).status, 'clear', id);
  assert.equal(assessUrgency(caseById('D')).news2.total, 15);
  assert.equal(assessUrgency(caseById('B')).news2.total, 0);
  for (const c of CASES) assert.equal(assessUrgency(c).status === 'urgent', c.expect === 'urgent', c.id);
});
