// The fixed instructions and the fixed message shape for a brief. The relay checks every request against this
// shape (it cannot read the encrypted text, but it can check the model, the roles and the exact sizes), so the
// prototype cannot be used as a general-purpose model endpoint.
import { factText } from '../cases/cases.mjs';
import { utf8ToBytes } from '../util/bytes.mjs';

export const SYSTEM_PROMPT = [
  'You help a clinical geneticist review a made-up research case. You receive numbered facts, one JSON object per line, each with its source.',
  'Rules:',
  '1. Use only the numbered facts. Never assume a result that is not reported. Cite the fact numbers behind every point.',
  '2. Keep the leading explanation apart from the gaps in the evidence. Give a leading explanation only if the facts support one, with a confidence of "low", "moderate" or "high"; if they do not, set "lead" to null.',
  '3. Propose exactly one next check: the single most useful next step for the clinician, specific enough to carry out. Name the test or examination and what it must cover, and say what it cannot show.',
  '4. If the facts are too thin for a lead, the next check gathers the missing evidence, such as a history and examination or the original report, and is not a genetic test.',
  '5. If any fact suggests the person may be acutely unwell now, the next check is an immediate handover to the treating team, before any genetic test.',
  '6. Never present a possible explanation as established. Never give treatment, medicine or dosing advice.',
  '7. The page displays the lab’s variant classifications and phase findings directly. In every text field, use the variant identifiers or “reported findings”. Omit classification words such as pathogenic, likely pathogenic, benign, likely benign, uncertain significance and VUS, and phase terms such as in trans, in cis, compound heterozygous and biallelic, including in negated or hypothetical phrases. If phase matters, say in plain words whether the source establishes that the variants are on different copies of the gene.',
  '8. Answer with one JSON object and nothing else, in exactly this shape:',
  '{"lead":{"explanation":"...","confidence":"low|moderate|high","facts":[1]},"gaps":[{"gap":"...","facts":[2]}],"next_check":{"type":"test|evidence|handover","check":"...","why":"...","facts":[3],"cannot_show":"..."}}',
  '"lead" may be null. Give one to three gaps. "type" is "test" for a laboratory or genetic test, "evidence" for gathering history, examination or records, and "handover" for handing over to the treating team. Keep every text value under 40 words.',
].join('\n');

/** The user message: the numbered facts as JSON lines, in order. Nothing else about the case is sent. */
export function userMessage(c) {
  return `Facts:\n${c.facts.map((f) => JSON.stringify({ n: f.n, fact: factText(f), source: f.source })).join('\n')}`;
}

// Bounds the relay enforces. A case's facts are well under 2 kB; MAX_USER_BYTES leaves room for longer cases.
// MAX_TOKENS covers the JSON brief plus the model's reasoning at low effort; at $0.50 per million output tokens a
// brief costs about a tenth of a cent.
export const MAX_USER_BYTES = 8192;
export const MAX_TOKENS = 2000;
export const TEMPERATURE = 0.2;
export const systemPromptBytes = () => utf8ToBytes(SYSTEM_PROMPT).length;

// The model DNA Confidential uses: served by NEAR AI itself inside its TEEs (owned_by "nearai"), with a hardware
// attestation and an attested signing key. The page checks that attestation for this exact model before sending.
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
export const MODEL_SETTINGS = {
  'z-ai/glm-5.3-flash': { reasoning_effort: 'low' },
  'Qwen/Qwen3.8-27B': { chat_template_kwargs: { enable_thinking: false } },
};

/** The one request shape the relay accepts; only the encrypted messages vary. */
export function briefBody(model, messages) {
  return { model, messages, max_tokens: MAX_TOKENS, temperature: TEMPERATURE, stream: false, ...(MODEL_SETTINGS[model] || {}) };
}
