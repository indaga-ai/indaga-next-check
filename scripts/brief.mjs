// The whole flow from the command line, without a browser, straight to NEAR AI Cloud (no relay):
//   npm run brief -- --case D                       an urgent case: the fixed rules stop it; no key needed
//   NEARAI_API_KEY=... npm run brief -- --case A    one case through the attested model
//   NEARAI_API_KEY=... npm run brief -- --case A,B,C,D --json checks/run.json
//   NEARAI_API_KEY=... npm run brief -- --case D --no-gate    comparison only: what the model says without the rules
// For each case it prints the facts and runs the urgency rules. For a case they clear, it checks the hardware
// (Intel and NVIDIA included), encrypts the facts to the attested key, decrypts the reply, checks the brief and
// checks the signature. Exit code 0 means every check on every case passed.
import { writeFileSync } from 'node:fs';
import { CASES, caseById, factText, sourceClassifications } from '../src/cases/cases.mjs';
import { assessUrgency } from '../src/triage/urgency.mjs';
import { verifyModelAttestation, newNonce } from '../src/tee/attestation.mjs';
import { quoteVerifier, gpuVerifier } from '../src/tee/hardware.mjs';
import { newClientKeys, encryptMessages, decryptWith, e2eeHeaders } from '../src/tee/e2ee.mjs';
import { verifyReplySignature } from '../src/tee/signature.mjs';
import { SYSTEM_PROMPT, userMessage, briefBody, DEFAULT_MODEL } from '../src/ai/prompt.mjs';
import { parseBrief, checkBrief } from '../src/ai/brief.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const noGate = flag('--no-gate');
const jsonOut = opt('--json');
const ids = (opt('--case') || CASES.map((c) => c.id).join(',')).split(',');
const cases = ids.map((id) => caseById(id) || (() => { throw new Error(`no case ${id}; the cases are ${CASES.map((c) => c.id).join(', ')}`); })());
const key = process.env.NEARAI_API_KEY || '';
const base = process.env.NEARAI_BASE || 'https://cloud-api.near.ai/v1';
const model = process.env.MODEL || DEFAULT_MODEL;
const mark = (ok) => (ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP');
const indent = (s) => String(s).split('\n').map((l) => `     ${l}`).join('\n');

let attestation = null;
async function attest() {
  if (attestation) return attestation;
  const nonce = newNonce();
  const q = new URLSearchParams({ model, provider: 'near', signing_algo: 'ed25519', nonce, include_tls_fingerprint: 'false' });
  const report = await (await fetch(`${base}/attestation/report?${q}`, { headers: { 'x-no-aliasing': 'true' } })).json();
  attestation = await verifyModelAttestation(report, { model, nonce, signingAlgo: 'ed25519', verifyQuote: quoteVerifier(), verifyGpu: gpuVerifier() });
  console.log(`\n== Hardware report for ${model} (nonce ${nonce.slice(0, 16)}...)`);
  for (const c of attestation.checks) console.log(`   ${mark(c.ok)}  ${c.label}`);
  console.log(attestation.ok ? `   VERIFIED: the model key ${attestation.key.publicKey.slice(0, 16)}... is held inside attested hardware.` : '   NOT VERIFIED: nothing will be sent.');
  return attestation;
}

async function send(c, att) {
  const client = newClientKeys();
  const messages = encryptMessages(att.key.publicKey, client.publicKey, [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMessage(c) }]);
  const requestBytes = new TextEncoder().encode(JSON.stringify(briefBody(model, messages)));
  const t0 = Date.now();
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true', authorization: `Bearer ${key}`, ...e2eeHeaders(client.publicKey, att.key.publicKey) },
    body: requestBytes,
  });
  const responseBytes = new Uint8Array(await r.arrayBuffer());
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${new TextDecoder().decode(responseBytes).slice(0, 300)}`);
  const elapsedMs = Date.now() - t0;
  // NEAR AI's billing looks a request up by the UUID in this header (POST /v1/billing/costs).
  const inferenceId = r.headers.get('inference-id');
  const reply = JSON.parse(new TextDecoder().decode(responseBytes));
  const choice = reply.choices?.[0];
  const text = decryptWith(client.secretKey, choice?.message?.content || '');
  let sig = null;
  for (let i = 0; i < 6 && !sig; i++) {
    const s = await fetch(`${base}/signature/${encodeURIComponent(reply.id)}?signing_algo=ed25519`, { headers: { authorization: `Bearer ${key}`, 'x-no-aliasing': 'true' } });
    if (s.status === 404) await new Promise((ok) => setTimeout(ok, 1000));
    else sig = await s.json();
  }
  const signature = verifyReplySignature({ sig, model, requestBytes, responseBytes, key: att.key });
  return { text, elapsedMs, finish: choice?.finish_reason ?? null, usage: reply.usage ?? null, requestBytes: requestBytes.length, signature, inferenceId, replyId: reply.id ?? null };
}

const results = [];
let failed = false;
for (const c of cases) {
  console.log(`\n== Case ${c.id}: ${c.title} (shows: ${c.shows})`);
  for (const f of c.facts) console.log(`   ${f.n}. ${factText(f)}\n      [${f.source}]${f.critical ? '  (lab: critical)' : ''}`);
  const gate = assessUrgency(c);
  console.log(`\n   Urgency rules (fixed, before any AI step): ${gate.status.toUpperCase()}`);
  if (gate.news2) console.log(`   NEWS2: ${gate.news2.parts.map((p) => `${p.label} ${p.value ?? 'missing'} = ${p.points ?? '?'}`).join('; ')}; total ${gate.news2.total}`);
  for (const r of gate.reasons) console.log(`   - ${r.text}${r.fact ? ` (fact ${r.fact})` : ''}`);
  const record = { case: c.id, shows: c.shows, expect: c.expect, gate: { status: gate.status, reasons: gate.reasons, news2: gate.news2 && { total: gate.news2.total, complete: gate.news2.complete, red: gate.news2.red, risk: gate.news2.risk } }, sent: false };
  results.push(record);
  if (gate.status !== 'clear' && !noGate) {
    console.log(gate.status === 'urgent'
      ? '\n   STOP: hand over to the treating team now. Genetic testing does not come first; the brief can be written once the treating team says the person is stable. Nothing was sent to the AI.'
      : '\n   HELD: a person must first confirm that the patient is not acutely unwell. Nothing was sent to the AI.');
    record.matchesExpect = c.expect === gate.status;
    continue;
  }
  if (gate.status !== 'clear') console.log('\n   --no-gate: COMPARISON ONLY. The rules would stop this case; it is sent anyway to see what the model alone says.');
  if (!key) {
    console.error('\n   Set NEARAI_API_KEY (from cloud.near.ai) to send this case to the attested model.');
    failed = true;
    continue;
  }
  const att = await attest();
  record.attestation = { ok: att.ok, instance: att.tee?.instanceId ?? null, composeHash: att.tee?.composeHash ?? null, modelKey: att.key?.publicKey ?? null };
  if (!att.ok) {
    failed = true;
    continue;
  }
  try {
    const out = await send(c, att);
    record.sent = true;
    Object.assign(record, { model, elapsedMs: out.elapsedMs, finish: out.finish, usage: out.usage, requestBytes: out.requestBytes, inferenceId: out.inferenceId, replyId: out.replyId, text: out.text });
    console.log(`\n   Sent ${out.requestBytes.toLocaleString()} bytes of ciphertext (E2EE v3). Reply in ${(out.elapsedMs / 1000).toFixed(1)} s, finish ${out.finish}, tokens ${out.usage?.total_tokens ?? '?'}.`);
    const { brief, error } = parseBrief(out.text);
    const checked = brief ? checkBrief(brief, c, gate) : { ok: false, checks: [{ id: 'shape', label: 'One JSON brief in the agreed shape', ok: false, detail: error }], flags: [] };
    record.brief = brief;
    record.sourceClassifications = sourceClassifications(c);
    const accepted = checked.ok && out.signature.ok && out.finish !== 'length';
    if (accepted) {
      for (const { variant, classification, fact } of record.sourceClassifications) {
        console.log(`   Source report (fact ${fact}): ${variant} · ${classification}`);
      }
      console.log(indent(out.text));
    } else {
      console.log('   Reply rejected. See the checks below.');
    }
    record.briefChecks = checked.checks;
    record.flags = checked.flags;
    console.log('\n   Brief checks:');
    for (const k of checked.checks) console.log(`   ${mark(k.ok)}  ${k.label}: ${k.detail}`);
    for (const f of checked.flags) console.log(`   FLAG  ${f.text}`);
    console.log('   Signature:');
    for (const k of out.signature.checks) console.log(`   ${mark(k.ok)}  ${k.label}`);
    record.signature = { ok: out.signature.ok, checks: out.signature.checks.map((k) => ({ id: k.id, ok: k.ok })) };
    if (!accepted) failed = true;
    const got = !brief ? 'no brief' : brief.next_check?.type === 'handover' ? 'urgent' : brief.lead === null ? 'insufficient' : 'lead';
    record.got = got;
    record.matchesExpect = got === c.expect;
    console.log(`\n   ${record.matchesExpect ? 'As expected' : 'NOTE: not as expected'}: the case shows "${c.expect}", the brief reads as "${got}".`);
  } catch (e) {
    console.error(`\n   The request failed: ${e.message}`);
    record.error = e.message;
    failed = true;
  }
}

// What NEAR AI's own billing charged for the briefs sent, by inference id. Its records can lag a little.
const sentIds = results.map((r) => r.inferenceId).filter(Boolean);
if (key && sentIds.length) {
  await new Promise((ok) => setTimeout(ok, 3000));
  try {
    const r = await fetch(`${base}/billing/costs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ requestIds: sentIds }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
    const byId = new Map((data.requests || []).map((x) => [x.requestId, x.costNanoUsd]));
    let total = 0;
    for (const rec of results.filter((x) => x.inferenceId)) {
      rec.costUsd = (byId.get(rec.inferenceId) ?? 0) / 1e9;
      total += rec.costUsd;
    }
    console.log(`\nCost from NEAR AI's billing: $${total.toFixed(6)} for ${sentIds.length} brief(s)${data.warning ? ` (note: ${data.warning})` : ''}.`);
  } catch (e) {
    console.log(`\nCost lookup unavailable: ${e.message}`);
  }
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ when: new Date().toISOString(), model, noGate, results }, null, 2)}\n`);
  console.log(`\nWrote ${jsonOut}`);
}
process.exit(failed ? 1 : 0);
