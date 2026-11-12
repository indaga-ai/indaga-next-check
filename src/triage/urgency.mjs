// Fixed rules that run on the page before any AI step. The AI never decides whether a case is urgent.
//
// Why: in Indaga's 12 Nov 2026 four-case model test, the first local prototype was given an acute emergency and
// put a laboratory workup first, leaving out stabilisation and heart monitoring. A genetics brief must not come
// before the care an acutely unwell person needs, so urgency is screened by rules a person can read, here.
//
// The rules, in order:
// 1. A result the lab itself flagged as critical makes the case urgent.
// 2. For an adult (16 or over) with observations, NEWS2 scores them (Royal College of Physicians, 2017, chart 1).
//    A score of 3 in any single parameter, or a total of 5 or more, makes the case urgent (chart 2: the red score
//    and the key threshold for an urgent response).
// 3. If nothing is urgent, the case goes on only when the urgency could be ruled out: a complete NEWS2 set with a
//    low score, or a named clinician's confirmation that the person is not acutely unwell. Otherwise it is held
//    for a person.
// These rules catch only what they check. NEWS2 is for adults and is not used for children or in pregnancy here;
// it reads observations, not blood results, which is why rule 1 exists.

export const NEWS2_SOURCE = {
  label: 'Royal College of Physicians. National Early Warning Score (NEWS) 2, 2017: chart 1 (scoring) and chart 2 (thresholds and triggers)',
  url: 'https://www.rcp.ac.uk/resources/national-early-warning-score-news-2/',
};

export const NEWS2_MIN_AGE = 16;

// Chart 1, SpO2 scale 1. Each band is [upper bound, points]; a value scores the points of the first band it fits.
const BANDS = {
  respiratoryRate: { label: 'Breathing rate', unit: 'a minute', round: 0, bands: [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]] },
  spo2: { label: 'Oxygen saturation', unit: '%', round: 0, bands: [[91, 3], [93, 2], [95, 1], [Infinity, 0]] },
  systolic: { label: 'Systolic blood pressure', unit: 'mmHg', round: 0, bands: [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]] },
  pulse: { label: 'Pulse', unit: 'a minute', round: 0, bands: [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]] },
  temperature: { label: 'Temperature', unit: '°C', round: 1, bands: [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]] },
};

// ACVPU: anything other than "alert" (new confusion, or responding only to voice or pain, or unresponsive) scores 3.
const CONSCIOUSNESS = ['alert', 'new confusion', 'voice', 'pain', 'unresponsive'];

const roundTo = (x, places) => Math.round(x * 10 ** places) / 10 ** places;

/** Points for one numeric parameter, or null when the value is missing or not a number. */
export function news2Points(name, value) {
  const spec = BANDS[name];
  if (!spec) throw new Error(`unknown NEWS2 parameter: ${name}`);
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const v = roundTo(value, spec.round);
  return spec.bands.find(([upper]) => v <= upper)[1];
}

/** Scores a set of observations with NEWS2. Missing parameters are listed and leave the score incomplete. */
export function scoreNews2(obs) {
  const parts = [];
  for (const [name, spec] of Object.entries(BANDS)) {
    const points = news2Points(name, obs[name]);
    parts.push({ name, label: spec.label, value: points === null ? null : `${obs[name]} ${spec.unit}`.replace(' %', '%'), points });
  }
  const onOxygen = typeof obs.onOxygen === 'boolean' ? obs.onOxygen : null;
  parts.push({ name: 'onOxygen', label: 'Air or oxygen', value: onOxygen === null ? null : onOxygen ? 'oxygen' : 'air', points: onOxygen === null ? null : onOxygen ? 2 : 0 });
  const c = CONSCIOUSNESS.includes(obs.consciousness) ? obs.consciousness : null;
  parts.push({ name: 'consciousness', label: 'Consciousness', value: c, points: c === null ? null : c === 'alert' ? 0 : 3 });
  const scored = parts.filter((p) => p.points !== null);
  const total = scored.reduce((n, p) => n + p.points, 0);
  const complete = scored.length === parts.length;
  const red = scored.some((p) => p.points === 3);
  return { parts, total, complete, red, ...news2Response(total, red) };
}

/** Chart 2: the clinical risk and the response for a total and the red-score rule. */
export function news2Response(total, red) {
  if (total >= 7) return { risk: 'high', response: 'urgent or emergency response' };
  if (total >= 5) return { risk: 'medium', response: 'key threshold for an urgent response' };
  if (red) return { risk: 'low–medium', response: 'urgent ward-based response (a score of 3 in one parameter)' };
  return { risk: 'low', response: 'ward-based response' };
}

/**
 * The page's decision for one case: 'urgent' (stop: a person first), 'hold' (urgency not ruled out: a person
 * first) or 'clear' (the brief may be written). `reasons` say why, each with the fact it rests on.
 */
export function assessUrgency(c) {
  const urgent = [];
  const clearedBy = [];
  for (const f of c.facts) {
    if (f.critical) urgent.push({ text: `The lab flagged a result in fact ${f.n} as critical.`, fact: f.n });
  }
  let news2 = null;
  const adult = typeof c.patient?.age === 'number' && c.patient.age >= NEWS2_MIN_AGE;
  if (c.observations && adult) {
    news2 = scoreNews2(c.observations);
    const fact = c.observations.fact ?? null;
    for (const p of news2.parts.filter((x) => x.points === 3)) {
      urgent.push({ text: `${p.label} (${p.value}) scores 3 on NEWS2, a red score on its own.`, fact });
    }
    if (news2.total >= 5) {
      urgent.push({ text: `NEWS2 totals ${news2.total}${news2.complete ? '' : ' from the parameters recorded'}: ${news2.risk} clinical risk, ${news2.response}.`, fact });
    }
    if (news2.complete && news2.total < 5 && !news2.red) {
      clearedBy.push({ text: `NEWS2 totals ${news2.total} from a complete set of observations: ${news2.risk} clinical risk.`, fact });
    }
  }
  if (urgent.length) return { status: 'urgent', reasons: urgent, news2, adult };
  if (!clearedBy.length && c.stable?.by) {
    clearedBy.push({ text: `${c.stable.by[0].toUpperCase()}${c.stable.by.slice(1)} confirmed that the person is not acutely unwell.`, fact: c.stable.fact ?? null });
  }
  if (clearedBy.length) return { status: 'clear', reasons: clearedBy, news2, adult };
  return {
    status: 'hold',
    reasons: [{ text: adult
      ? 'These rules could not rule out an urgent presentation: there is no complete set of observations to score, and no clinician has confirmed that the person is not acutely unwell.'
      : 'These rules could not rule out an urgent presentation: NEWS2 is for adults, and no clinician has confirmed that this child is not acutely unwell.', fact: null }],
    news2,
    adult,
  };
}
