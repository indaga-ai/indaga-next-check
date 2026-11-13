// Reads the model's reply and checks it on the page. The checks are about form and traceability: one JSON brief,
// exactly one next check, every point tied to real fact numbers, a lead that says how confident it is, and no
// model-written variant classifications or phase. They cannot judge whether the medicine is right; that is the
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

// Source classifications are shown separately. Keep ACMG/AMP class terms and common
// aliases out of generated text entirely, including where the source uses the same term.
const CLASS_WORDING = /\b(?:pathogenic|benign|(?:uncertain|unknown)[\s-]+significance|VUS|VOUS|disease[\s-]+causing)\b/i;
const CLASS_CODES = /\b(?:LP|LB|ACMG[\s-]+(?:class[\s-]+)?[1-5])\b/;
// Phase (whether two variants sit on different copies of a gene) is also shown from the source report. Its
// standard terms stay out of generated text, even negated: a live brief once called two variants "in trans"
// although the lab had not established phase. A plain-words claim about phase is not caught here.
const PHASE_WORDING = /\b(?:in[\s-]+trans|in[\s-]+cis|compound[\s-]+heterozyg\w*|bi-?allelic|(?:trans|cis)[\s-]+(?:configuration|phase|position|arrangement))\b/i;

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

  const text = brief ? allText(brief).normalize('NFKC') : '';
  const classWording = CLASS_WORDING.test(text) || CLASS_CODES.test(text);
  checks.push({
    id: 'classes', label: 'Variant classifications come only from the source report', ok: shapeOk && !classWording,
    detail: !shapeOk ? 'No brief to read.'
      : classWording ? 'The generated brief uses variant classification wording. Use the source report for classifications.'
        : 'The generated brief leaves variant classifications to the source report.',
  });

  const phaseWording = PHASE_WORDING.test(text);
  checks.push({
    id: 'phase', label: 'Phase comes only from the source report', ok: shapeOk && !phaseWording,
    detail: !shapeOk ? 'No brief to read.'
      : phaseWording ? 'The generated brief uses phase wording (in trans, in cis, compound heterozygous or biallelic). Use the source report for phase.'
        : 'The generated brief leaves phase to the source report.',
  });

  const flags = [];
  if (brief) {
    if (TREATMENT.some((re) => re.test(text))) flags.push({ id: 'treatment', text: 'The wording mentions a dose or a treatment step. This brief is for choosing a next check, not treatment: a clinician should read that sentence closely.' });
    if (SETTLED.some((re) => re.test(text))) flags.push({ id: 'settled', text: 'The wording may present a diagnosis as settled. Nothing here establishes a diagnosis.' });
    if (lead === null && nc?.type === 'test') flags.push({ id: 'test-without-lead', text: 'The brief names no lead but proposes a test. When the facts are too thin, the next check usually gathers evidence first.' });
    if (nc?.type === 'handover' && gate?.status === 'clear') flags.push({ id: 'handover-when-clear', text: 'The model asks for a handover although the fixed rules found no urgent sign. The rules and the model disagree: a clinician should look now.' });
  }
  return { ok: checks.every((x) => x.ok), checks, flags };
}
