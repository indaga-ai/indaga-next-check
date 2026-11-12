// The made-up cases. Every person, date, letter and result here is invented for this prototype; none is a real
// patient or a published case report. Cases A, B and C reuse the fictional vignettes of Indaga's 12 Nov 2026 model
// test (P03, P02 and P05), with sources added to each fact. Case D was written for this prototype.
//
// Each fact has a number and a source, and the page shows both. Only the facts are sent to the model. The other
// fields are for the page's fixed urgency rules (src/triage/urgency.mjs) and for display:
//   patient.age      years; NEWS2 applies from age 16
//   observations     a full set of observations, scored with NEWS2 (adults only); `fact` names the fact they come from
//   stable           a named clinician confirmed the person is not acutely unwell; `fact` names the fact that says so
//   fact.critical    the lab itself flagged this result as critical
//   fact.variantClassifications  each exact variant and its classification, transcribed from this source report
//   shows / expect   what the case demonstrates; never sent, never used by the rules

export const CASES = [
  {
    id: 'A',
    title: 'A 5-year-old whose first test left a gap',
    shows: 'A well-supported lead',
    expect: 'lead',
    patient: { age: 5 },
    setting: 'Genetics outpatient clinic',
    stable: { by: 'his paediatrician', fact: 5 },
    observations: null,
    facts: [
      { n: 1, text: 'A 5-year-old boy has found running and climbing stairs harder over the past year. He falls often and pushes on his thighs to stand up from the floor.', source: 'Referral letter from his paediatrician, 28 Oct 2026' },
      { n: 2, text: 'Creatine kinase is 11,000 U/L; the lab\'s range is 40 to 200 U/L.', source: 'Hospital lab report, 21 Oct 2026' },
      { n: 3, text: 'A DMD copy-number test (MLPA, all 79 exons) found no deletion or duplication of a whole exon.', source: 'Genetics lab report, 4 Nov 2026' },
      { n: 4, text: 'The same report says this test cannot detect small sequence changes, such as single-letter changes or small insertions and deletions.', source: 'Genetics lab report, 4 Nov 2026: limitations' },
      { n: 5, text: 'He is well between visits and has no breathing problems. He is seen in the outpatient clinic.', source: 'Referral letter from his paediatrician, 28 Oct 2026' },
    ],
  },
  {
    id: 'B',
    title: 'A 39-year-old with two variants and no phase',
    shows: 'A lead with one decisive gap',
    expect: 'lead',
    patient: { age: 39 },
    setting: 'Neuromuscular outpatient clinic',
    stable: null,
    observations: { respiratoryRate: 15, spo2: 97, onOxygen: false, systolic: 124, pulse: 72, consciousness: 'alert', temperature: 36.7, fact: 2 },
    facts: [
      { n: 1, text: 'A 39-year-old has slowly progressive weakness around the hips and shoulders and finds stairs hard.', source: 'Neurology clinic letter, 30 Oct 2026' },
      { n: 2, text: 'Clinic observations: breathing 15 a minute, oxygen saturation 97% on air, blood pressure 124/78 mmHg, pulse 72 a minute, alert, temperature 36.7 °C.', source: 'Clinic observations, 30 Oct 2026' },
      {
        n: 3,
        text: 'A gene panel reports two GAA variants, each found in one copy.',
        source: 'Genetics lab report, 6 Nov 2026',
        variantClassifications: [
          { variant: 'GAA c.-32-13T>G', classification: 'pathogenic' },
          { variant: 'GAA c.2560C>T (p.Arg854Ter)', classification: 'pathogenic' },
        ],
      },
      { n: 4, text: 'The lab did not establish whether the two variants are on different copies of the gene (phase). No GAA enzyme activity result is available.', source: 'Genetics lab report, 6 Nov 2026: limitations' },
      { n: 5, text: 'There is no new shortness of breath and no recent sudden worsening.', source: 'Neurology clinic letter, 30 Oct 2026' },
    ],
  },
  {
    id: 'C',
    title: 'A 9-year-old who tires during sports',
    shows: 'Too little evidence for a lead',
    expect: 'insufficient',
    patient: { age: 9 },
    setting: 'Paediatric outpatient query',
    stable: { by: 'the clinic\'s intake nurse', fact: 5 },
    observations: null,
    facts: [
      { n: 1, text: 'A parent says their 9-year-old gets tired during sports and asks whether it could be genetic.', source: 'Parent\'s message to the clinic, 2 Nov 2026' },
      { n: 2, text: 'A consumer DNA app summary says "no markers flagged". It does not list which genes or variants it tested.', source: 'Consumer DNA app summary, uploaded by the parent' },
      { n: 3, text: 'No examination, strength testing or timeline of the symptoms is on file, and it is not clear what "tired" means here.', source: 'Clinic intake note, 3 Nov 2026' },
      { n: 4, text: 'No clinical genetic test report is available.', source: 'Clinic intake note, 3 Nov 2026' },
      { n: 5, text: 'A routine outpatient query: the intake nurse spoke with the parent, and the child is otherwise well.', source: 'Clinic intake note, 3 Nov 2026' },
    ],
  },
  {
    id: 'D',
    title: 'A 23-year-old, confused after a long run',
    shows: 'An urgent presentation: a person first',
    expect: 'urgent',
    patient: { age: 23 },
    setting: 'Emergency department',
    stable: null,
    observations: { respiratoryRate: 28, spo2: 90, onOxygen: false, systolic: 96, pulse: 134, consciousness: 'new confusion', temperature: 38.4, fact: 2 },
    facts: [
      { n: 1, text: 'A 23-year-old is brought to the emergency department after a long training run, confused and breathless.', source: 'Ambulance handover, 9 Nov 2026' },
      { n: 2, text: 'Observations on arrival: breathing 28 a minute, oxygen saturation 90% on air, blood pressure 96/58 mmHg, pulse 134 a minute and irregular, newly confused, temperature 38.4 °C.', source: 'Emergency department observations, 9 Nov 2026' },
      { n: 3, text: 'Since age 15 there have been three episodes of muscle pain and dark urine after long exercise or a missed meal.', source: 'Family\'s account, 9 Nov 2026' },
      { n: 4, text: 'Creatine kinase is 85,000 U/L. Potassium is 6.6 mmol/L, which the lab flagged as a critical result and phoned through.', source: 'Emergency laboratory report, 9 Nov 2026', critical: true },
      { n: 5, text: 'No genetic test has been done. The family asks whether this could be inherited.', source: 'Ambulance handover, 9 Nov 2026' },
    ],
  },
];

/** Source classifications are copied from the case facts, never the generated reply. */
export function sourceClassifications(c) {
  return c.facts.flatMap((fact) => (fact.variantClassifications ?? []).map(({ variant, classification }) => ({
    variant, classification, fact: fact.n, source: fact.source,
  })));
}

export function factText(fact) {
  if (!fact.variantClassifications?.length) return fact.text;
  const entries = fact.variantClassifications.map(({ variant, classification }) => `${variant}: ${classification}`);
  return `${fact.text} Reported classifications: ${entries.join('; ')}.`;
}

export const caseById = (id) => CASES.find((c) => c.id === String(id).toUpperCase()) || null;
