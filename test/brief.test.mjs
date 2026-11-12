// Reading and checking the model's brief on the page: the JSON, exactly one next check, citations that name real
// facts, a lead that states its confidence, and flags that point a reviewer at risky wording without false alarms
// on ordinary lab values or on how a confirmatory test is described.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrief, checkBrief } from '../src/ai/brief.mjs';
import { caseById } from '../src/cases/cases.mjs';

const A = caseById('A');
const good = () => ({
  lead: { explanation: 'A dystrophinopathy fits facts 1 and 2; the copy-number test leaves small variants open.', confidence: 'moderate', facts: [1, 2, 3, 4] },
  gaps: [{ gap: 'Small sequence variants in DMD were outside the first test.', facts: [3, 4] }],
  next_check: { type: 'test', check: 'DMD sequencing covering all exons and splice regions.', why: 'The first test could not see small variants.', facts: [3, 4], cannot_show: 'Deep intronic changes.' },
});
const ids = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));

test('parse: a bare object or one fenced as JSON; anything around it is refused', () => {
  const s = JSON.stringify(good());
  assert.deepEqual(parseBrief(s).brief, good());
  assert.deepEqual(parseBrief(`\`\`\`json\n${s}\n\`\`\``).brief, good());
  assert.match(parseBrief(`Here is the brief: ${s}`).error, /outside/);
  assert.match(parseBrief('{"lead": null,').error, /no JSON object|not valid JSON/);
  assert.match(parseBrief('[1, 2]').error, /no JSON object/);
  assert.match(parseBrief('').error, /no JSON object/);
});

test('a well-formed brief passes every check and raises no flag', () => {
  const r = checkBrief(good(), A);
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(r.flags, []);
});

test('citations must name this case\'s facts, as whole numbers, in every part', () => {
  for (const facts of [[0], [6], ['2'], [2.5], []]) {
    const b = good();
    b.next_check.facts = facts;
    assert.equal(ids(checkBrief(b, A)).cited, false, JSON.stringify(facts));
  }
  const b = good();
  delete b.gaps[0].facts;
  assert.equal(ids(checkBrief(b, A)).cited, false, 'a gap without facts');
});

test('exactly one next check, typed, with its reason and its limits', () => {
  const arr = good();
  arr.next_check = [arr.next_check, arr.next_check];
  assert.equal(ids(checkBrief(arr, A)).shape, false, 'two next checks');
  for (const field of ['type', 'check', 'why', 'cannot_show']) {
    const b = good();
    delete b.next_check[field];
    assert.equal(ids(checkBrief(b, A))['one-check'], false, field);
  }
  const t = good();
  t.next_check.type = 'treatment';
  assert.equal(ids(checkBrief(t, A))['one-check'], false, 'an unknown type');
});

test('gaps: one to three, each with text', () => {
  for (const gaps of [[], [1, 2, 3, 4].map(() => good().gaps[0]), [{ gap: '', facts: [1] }]]) {
    const b = good();
    b.gaps = gaps;
    assert.equal(ids(checkBrief(b, A)).cited, false, JSON.stringify(gaps).slice(0, 40));
  }
});

test('a lead states its confidence; no lead is allowed', () => {
  const none = good();
  none.lead = null;
  none.next_check.type = 'evidence';
  assert.equal(checkBrief(none, A).ok, true);
  const vague = good();
  vague.lead.confidence = 'likely';
  assert.equal(ids(checkBrief(vague, A)).lead, false);
});

test('flags: a dose or treatment step, a settled diagnosis, a test without a lead, and a handover the rules did not call', () => {
  const flagIds = (b, gate) => checkBrief(b, A, gate).flags.map((f) => f.id);
  const dose = good();
  dose.next_check.why = 'Give 20 mg/kg while waiting.';
  assert.deepEqual(flagIds(dose), ['treatment']);
  const start = good();
  start.gaps[0].gap = 'Start enzyme replacement therapy now.';
  assert.deepEqual(flagIds(start), ['treatment']);
  const settled = good();
  settled.lead.explanation = 'The diagnosis is confirmed by the raised creatine kinase.';
  assert.deepEqual(flagIds(settled), ['settled']);
  const thin = good();
  thin.lead = null;
  assert.deepEqual(flagIds(thin), ['test-without-lead']);
  const handover = good();
  handover.next_check.type = 'handover';
  assert.deepEqual(flagIds(handover, { status: 'clear' }), ['handover-when-clear']);
  assert.deepEqual(flagIds(handover, { status: 'urgent' }), []);
});

test('no false flags on lab values or on how a confirmatory test is described', () => {
  const b = good();
  b.lead.explanation = 'Creatine kinase 11,000 U/L and potassium 6.6 mmol/L are reported; haemoglobin 13.2 g/dL.';
  b.next_check.why = 'A positive result would confirm the diagnosis; it may confirm a diagnosis of a dystrophinopathy.';
  b.next_check.cannot_show = 'It cannot show whether treatment will be needed.';
  assert.deepEqual(checkBrief(b, A).flags, []);
});
