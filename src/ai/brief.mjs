// Reads the model's reply and checks it on the page. The checks are about form and traceability: one JSON brief,
// exactly one next check, every point tied to real fact numbers, a lead that says how confident it is, and no
// variant class that the facts do not give. They cannot judge whether the medicine is right; that is the
// clinician's review, and the page says so.
// Flags point a reviewer at wording that needs a closer look. They are word patterns, not guarantees.

const CONFIDENCE = ['low', 'moderate', 'high'];
const TYPES = ['test', 'evidence', 'handover'];

/** Parses the reply text into a brief. Tolerates a ```json fence around the object, nothing else. */
export function parseBrief(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return { brief: null, error: 'the reply holds no JSON object' };
  if (t.slice(0, start).trim() || t.slice(end + 1).trim()) return { brief: null, error: 'the reply has text outside its JSON object' };
  try {
    const brief = JSON.parse(t.slice(start, end + 1));
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return { brief: null, error: 'the reply is not a JSON object' };
    return { brief, error: null };
  } catch (e) {
    return { brief: null, error: `the reply is not valid JSON (${e.message})` };
  }
}

const isText = (s) => typeof s === 'string' && s.trim().length > 0;
const isFactList = (a) => Array.isArray(a) && a.length > 0;

/** Every fact number cited anywhere in the brief, as given. */
export function citedFacts(brief) {
  const lists = [];
  if (brief?.lead && typeof brief.lead === 'object') lists.push(brief.lead.facts);
  if (Array.isArray(brief?.gaps)) for (const g of brief.gaps) lists.push(g?.facts);
  if (brief?.next_check && typeof brief.next_check === 'object') lists.push(brief.next_check.facts);
  return lists;
}

const TREATMENT = [
  /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|micrograms?|IU)\b/i,
  /\b\d+(?:[.,]\d+)?\s?(?:mg|ml|mL|units?|g)\s?\/\s?kg\b/,
  /\b(?:start|starting|begin|initiate|give|giving|administer|prescribe|commence)\b[^.;]{0,40}\b(?:therapy|treatment|enzyme replacement|steroids?|corticosteroids?|insulin|dextrose|fluids|calcium|bicarbonate|medicines?|medications?|drugs?)\b/i,
];
const SETTLED = [
  /\bdiagnosis (?:is|has been) (?:confirmed|established|made)\b/i,
  /(?<!\b(?:would|could|may|might|can|will|to|should)\s)\bconfirms? (?:the|a|this) diagnosis\b/i,
  /\bis diagnostic of\b/i,
  /\bhas been diagnosed\b/i,
];

// Variant classes, in the ACMG/AMP terms a lab report uses. "likely ..." is matched before the bare term, so
// "likely pathogenic" never counts as "pathogenic". "Benign" is also an ordinary adjective ("a benign course"), so
// it counts only next to a word for a variant.
const CLASS_RE = /\b(likely pathogenic|likely benign|pathogenic|benign|variants? of (?:uncertain|unknown) significance|uncertain significance|unknown significance|VUS|VOUS)\b/gi;
const VARIANT_WORD = /\b(?:variants?|alleles?|changes?|mutations?|findings?|polymorphisms?)\b/i;
// A class after "no" or "any" names no reported variant ("no pathogenic deletion", "to detect any pathogenic
// change"). After an indefinite word it is hypothetical only when its sentence says so ("sequencing may find a
// pathogenic variant"); "a likely pathogenic variant was found" still counts as a statement.
const NEGATING = /(?:^|[^\w])(?:no|any|without|not)\s+$/i;
const INDEFINITE = /(?:^|[^\w])(?:a|an|another|other|further|additional|new|second|possible|potential|candidate)\s+$/i;
const HYPOTHETICAL = /\b(?:may|might|could|would|if|whether|rule out|exclude|look(?:ing)? for|search(?:ing)? for|to (?:detect|find|identify|confirm))\b/i;

function normalizeClass(s) {
  const x = s.toLowerCase();
  return /significance|^vus$|^vous$/.test(x) ? 'uncertain significance' : x;
}

/**
 * The variant classes a text states about reported variants, in order: [{ cls, at }]. Mentions that name no
 * reported variant (negated, or hypothetical in their sentence) are left out.
 */
export function statedClasses(text) {
  const t = String(text ?? '');
  const out = [];
  for (const m of t.matchAll(CLASS_RE)) {
    const cls = normalizeClass(m[1]);
    const before = t.slice(Math.max(0, m.index - 48), m.index);
    const end = m.index + m[0].length;
    if (cls.endsWith('benign')) {
      const near = `${before.split(/\s+/).slice(-5).join(' ')} ${t.slice(end, end + 48).split(/\s+/).slice(0, 4).join(' ')}`;
      if (!VARIANT_WORD.test(near)) continue;
    }
    const from = Math.max(t.lastIndexOf('.', m.index), t.lastIndexOf(';', m.index), t.lastIndexOf('\n', m.index)) + 1;
    const stops = ['.', ';', '\n'].map((ch) => t.indexOf(ch, end)).filter((i) => i >= 0);
    const sentence = t.slice(from, stops.length ? Math.min(...stops) : t.length);
    if (NEGATING.test(before)) continue;
    if (INDEFINITE.test(before) && HYPOTHETICAL.test(sentence)) continue;
    out.push({ cls, at: m.index });
  }
  return out;
}

/** Classes the brief states that no fact of the case gives. Empty when every stated class is in the facts. */
export function misstatedClasses(brief, c) {
  const given = new Set(c.facts.flatMap((f) => statedClasses(f.text).map((x) => x.cls)));
  const stated = statedClasses(allText(brief)).map((x) => x.cls);
  return { given: [...given], stated: [...new Set(stated)], wrong: [...new Set(stated.filter((cls) => !given.has(cls)))] };
}

function allText(brief) {
  const out = [];
  (function walk(v) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(brief);
  return out.join('\n');
}

/**
 * Checks a parsed brief against the case it answers. `gate` is the page's urgency result for the case, when there
 * is one. Returns { ok, checks, flags }: `ok` when every check passed.
 */
export function checkBrief(brief, c, gate = null) {
  const n = c.facts.length;
  const checks = [];
  const shapeOk = Boolean(brief) && 'lead' in brief && Array.isArray(brief.gaps) && brief.next_check && typeof brief.next_check === 'object' && !Array.isArray(brief.next_check);
  checks.push({ id: 'shape', label: 'One JSON brief in the agreed shape', ok: shapeOk, detail: shapeOk ? 'A lead (or none), the gaps and the next check.' : 'The reply is missing "lead", "gaps" or a single "next_check" object.' });

  const nc = shapeOk ? brief.next_check : null;
  const oneOk = Boolean(nc) && TYPES.includes(nc.type) && isText(nc.check) && isText(nc.why) && isText(nc.cannot_show);
  checks.push({
    id: 'one-check', label: 'Exactly one next check, with its reason and its limits', ok: oneOk,
    detail: oneOk ? `A ${nc.type === 'test' ? 'test' : nc.type === 'evidence' ? 'step to gather evidence' : 'handover to the treating team'}, why it comes next, and what it cannot show.`
      : 'The next check needs a type (test, evidence or handover), the check itself, why, and what it cannot show.',
  });

  const lists = shapeOk ? citedFacts(brief) : [];
  const gapsOk = shapeOk && brief.gaps.length >= 1 && brief.gaps.length <= 3 && brief.gaps.every((g) => g && isText(g.gap));
  const everyCited = shapeOk && lists.length > 0 && lists.every(isFactList);
  const bad = lists.flat().filter((x) => !(Number.isInteger(x) && x >= 1 && x <= n));
  const citeOk = gapsOk && everyCited && bad.length === 0;
  checks.push({
    id: 'cited', label: 'Every point cites this case\'s numbered facts', ok: citeOk,
    detail: citeOk ? `Each part cites facts between 1 and ${n}.`
      : !gapsOk ? 'The brief needs one to three gaps, each with its text.'
        : !everyCited ? 'A part of the brief cites no fact.'
          : `It cites ${[...new Set(bad.map(String))].join(', ')}, which is not a fact of this case (1 to ${n}).`,
  });

  const lead = shapeOk ? brief.lead : undefined;
  const leadOk = lead === null || (lead && typeof lead === 'object' && isText(lead.explanation) && CONFIDENCE.includes(lead.confidence));
  checks.push({
    id: 'lead', label: 'A lead, if any, states its confidence', ok: Boolean(leadOk),
    detail: lead === null ? 'No lead: the model judged the facts too thin for one.'
      : leadOk ? `Offered as a possibility, with ${lead.confidence} confidence.` : 'A lead needs an explanation and a confidence of low, moderate or high.',
  });

  const cls = shapeOk ? misstatedClasses(brief, c) : { given: [], stated: [], wrong: [] };
  checks.push({
    id: 'classes', label: 'Every variant class it states is one the facts give', ok: shapeOk && cls.wrong.length === 0,
    detail: !shapeOk ? 'No brief to read.'
      : cls.wrong.length ? `It calls a variant "${cls.wrong.join('", "')}", which no fact says (${cls.given.length ? `the facts say: ${cls.given.join(', ')}` : 'the facts give no class'}). A misstated fact fails the brief.`
        : cls.stated.length ? `It states ${cls.stated.join(', ')}, as the facts do.` : 'It states no variant class.',
  });

  const flags = [];
  if (brief) {
    const text = allText(brief);
    if (TREATMENT.some((re) => re.test(text))) flags.push({ id: 'treatment', text: 'The wording mentions a dose or a treatment step. This brief is for choosing a next check, not treatment: a clinician should read that sentence closely.' });
    if (SETTLED.some((re) => re.test(text))) flags.push({ id: 'settled', text: 'The wording may present a diagnosis as settled. Nothing here establishes a diagnosis.' });
    if (lead === null && nc?.type === 'test') flags.push({ id: 'test-without-lead', text: 'The brief names no lead but proposes a test. When the facts are too thin, the next check usually gathers evidence first.' });
    if (nc?.type === 'handover' && gate?.status === 'clear') flags.push({ id: 'handover-when-clear', text: 'The model asks for a handover although the fixed rules found no urgent sign. The rules and the model disagree: a clinician should look now.' });
  }
  return { ok: checks.every((x) => x.ok), checks, flags };
}
