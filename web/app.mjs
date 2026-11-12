// The page. Everything here runs in the browser: the urgency rules, the hardware check, encrypting the facts,
// decrypting the brief, checking it and checking its signature. The server only relays ciphertext.
import { CASES, factText, sourceClassifications } from '../src/cases/cases.mjs';
import { assessUrgency, NEWS2_SOURCE } from '../src/triage/urgency.mjs';
import { verifyModelAttestation, newNonce } from '../src/tee/attestation.mjs';
import { quoteVerifier, gpuVerifier } from '../src/tee/hardware.mjs';
import { newClientKeys, encryptMessages, decryptWith, e2eeHeaders } from '../src/tee/e2ee.mjs';
import { verifyReplySignature, sha256Hex } from '../src/tee/signature.mjs';
import { SYSTEM_PROMPT, userMessage, briefBody, MAX_USER_BYTES } from '../src/ai/prompt.mjs';
import { parseBrief, checkBrief } from '../src/ai/brief.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};

const state = { config: null, case: null, gate: null, attestation: null, key: null };

function lock(stepId, locked) {
  const s = $(stepId);
  if (locked) s.setAttribute('data-locked', '');
  else s.removeAttribute('data-locked');
}

function fmtBytes(n) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} bytes`;
}

async function api(path, init) {
  const r = await fetch(path, init);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
}

// A button that names a fact; it scrolls to the fact and highlights it.
function factChip(n) {
  return el('button', { class: 'fact-chip', type: 'button', title: `Show fact ${n}`, onclick: () => showFact(n) }, String(n));
}
function factChips(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return el('span', { class: 'fact-chips', 'aria-label': 'facts' }, list.map((n) => (Number.isInteger(n) ? factChip(n) : el('span', { class: 'fact-chip bad', text: String(n) }))));
}
function showFact(n) {
  const row = $(`fact-${n}`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

// ---- Step 1 and 2: the case and its facts --------------------------------------------------------------------

function pickCase(c, button) {
  for (const b of $('cases').children) b.setAttribute('aria-pressed', String(b === button));
  state.case = c;
  const willSend = assessUrgency(c).status === 'clear';
  $('step-case').classList.add('done');
  lock('step-facts', false);
  $('step-facts').classList.add('done');
  $('facts').replaceChildren(
    el('p', { class: 'case-line' }, el('strong', { text: c.title }), ` · ${c.setting}`),
    el('div', { class: 'table-scroll' }, el('table', { class: 'facts' },
      el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'Fact' }), el('th', { text: 'Source' }))),
      el('tbody', {}, c.facts.map((f) => el('tr', { id: `fact-${f.n}` },
        el('td', { class: 'n', text: String(f.n) }),
        el('td', {}, factText(f), f.critical ? el('span', { class: 'tag bad', text: 'lab: critical' }) : null),
        el('td', { class: 'src', text: f.source }),
      ))),
    )),
    el('details', {}, el('summary', { text: willSend ? 'The exact text that will be encrypted and sent' : 'The text that would be sent: the rules in step 3 stop this case, so nothing is' }), el('pre', { text: userMessage(c) })),
  );
  renderUrgency(c);
  resetBrief();
}

// ---- Step 3: the urgency rules -------------------------------------------------------------------------------

function reasonList(reasons) {
  return el('ul', { class: 'reasons' }, reasons.map((r) => el('li', {}, r.text, r.fact ? factChips([r.fact]) : null)));
}

function news2Table(n) {
  return el('details', { open: true }, el('summary', { text: `NEWS2, scored on this page: ${n.total}${n.complete ? '' : ' (incomplete set)'}` }),
    el('div', { class: 'table-scroll' }, el('table', { class: 'news2' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Parameter' }), el('th', { text: 'Recorded' }), el('th', { text: 'Points' }))),
      el('tbody', {}, n.parts.map((p) => el('tr', { class: p.points === 3 ? 'red' : '' },
        el('td', { text: p.label }), el('td', { text: p.value ?? 'not recorded' }), el('td', { class: 'pts', text: p.points ?? '–' })))),
    )),
    el('p', { class: 'hint' }, `Total ${n.total}: ${n.risk} clinical risk, ${n.response}. Bands and thresholds: `, el('a', { href: NEWS2_SOURCE.url, rel: 'noopener', text: NEWS2_SOURCE.label }), '.'));
}

function beforeAfter() {
  return el('div', { class: 'before-after' },
    el('h3', { text: 'Why this step exists' }),
    el('div', { class: 'ba' },
      el('div', { class: 'ba-card before' },
        el('p', { class: 'overline', text: 'Before · the 12 Nov 2026 model test' }),
        el('p', { text: 'The first local prototype, a small open model with Indaga\'s gene lookups, was given an acute emergency. It put a laboratory workup first and left out stabilisation and heart monitoring. It scored 0 of 2 on that case.' })),
      el('div', { class: 'ba-card after' },
        el('p', { class: 'overline', text: 'After · this prototype' }),
        el('p', { text: 'Fixed rules check for urgency before any AI step, so this case stops here and no AI is asked. As a second line, the AI\'s instructions also tell it to hand an acutely unwell person over. In one comparison run on this case without the rules, the attested model did ask for a handover. The page does not rely on that.' })),
    ));
}

function renderUrgency(c) {
  const gate = assessUrgency(c);
  state.gate = gate;
  lock('step-urgency', false);
  const box = $('urgency');
  if (gate.status === 'urgent') {
    box.replaceChildren(
      el('div', { class: 'gate stop' },
        el('p', { class: 'gate-title', text: 'Stop: a person first' }),
        el('p', { class: 'gate-action', text: 'Hand over to the treating team now. Genetic testing does not come first: the brief can be written once the treating team says the person is stable. No AI is asked.' }),
        reasonList(gate.reasons)),
      gate.news2 ? news2Table(gate.news2) : null,
      beforeAfter(),
    );
    $('step-urgency').classList.remove('done');
  } else if (gate.status === 'hold') {
    box.replaceChildren(el('div', { class: 'gate hold' },
      el('p', { class: 'gate-title', text: 'Held for a person' }),
      el('p', { class: 'gate-action', text: 'Someone must confirm that the person is not acutely unwell before the AI is asked.' }),
      reasonList(gate.reasons)));
    $('step-urgency').classList.remove('done');
  } else {
    box.replaceChildren(
      el('div', { class: 'gate clear' },
        el('p', { class: 'gate-title', text: 'No urgent sign found by these rules' }),
        reasonList(gate.reasons),
        el('p', { class: 'hint', text: 'These rules check only NEWS2 for adults, the lab\'s own critical flags and a clinician\'s confirmation. They are not a triage system.' })),
      gate.news2 ? news2Table(gate.news2) : null,
    );
    $('step-urgency').classList.add('done');
  }
  const clear = gate.status === 'clear';
  lock('step-tee', !clear);
  $('check-tee').disabled = !clear;
  lock('step-brief', !(clear && state.key));
  $('send').disabled = !(clear && state.key);
  if (!clear) $('brief').replaceChildren(el('p', { class: 'status', text: 'Not needed: this case stops at step 3.' }));
}

// ---- Step 4: the hardware ------------------------------------------------------------------------------------

// The same grouping as DNA Confidential's page; the ids are the checks in src/tee/attestation.mjs.
const GROUPS = [
  ['Is this report genuine and fresh?', ['model', 'nonce-echo', 'quote-format', 'intel', 'not-debug']],
  ['Is the model key inside the hardware?', ['report-nonce', 'report-key']],
  ['What software runs there?', ['compose-bound', 'rtmr3', 'deploy-log']],
  ['Are the GPUs in confidential mode?', ['gpu-nonce', 'nvidia']],
  ['And the route in between?', ['gateway']],
];

function renderChecks(container, checks) {
  container.append(el('ul', { class: 'checks' }, checks.map((c) => el('li', { class: 'check' },
    el('span', { class: `mark ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'skip'}`, text: c.ok === true ? '✓' : c.ok === false ? '✕' : '–', 'aria-label': c.ok === true ? 'passed' : c.ok === false ? 'failed' : 'not checked' }),
    el('div', {}, el('div', { class: 'label', text: c.label }), el('div', { class: 'detail', text: c.detail || '' }), c.where ? el('div', { class: 'where', text: `checked: ${c.where}` }) : null),
  ))));
}

function renderGroupedChecks(container, checks) {
  const seen = new Set();
  for (const [title, ids] of GROUPS) {
    const part = checks.filter((c) => ids.includes(c.id));
    if (!part.length) continue;
    part.forEach((c) => seen.add(c.id));
    container.append(el('h3', { class: 'group', text: title }));
    renderChecks(container, part);
  }
  const rest = checks.filter((c) => !seen.has(c.id));
  if (rest.length) renderChecks(container, rest);
}

async function checkHardware() {
  const out = $('tee');
  const button = $('check-tee');
  button.disabled = true;
  out.replaceChildren(el('p', { class: 'status' }, el('span', { class: 'spinner' }), 'Asking for a fresh hardware report and checking it...'));
  try {
    const nonce = newNonce();
    const report = await api(`api/attestation?nonce=${nonce}`);
    const result = await verifyModelAttestation(report, {
      model: state.config.model,
      nonce,
      signingAlgo: 'ed25519',
      verifyQuote: quoteVerifier({ pccsUrl: new URL('api/pccs', location.href).href.replace(/\/$/, '') }),
      verifyGpu: gpuVerifier({ nrasUrl: new URL('api/nras', location.href).href }),
    });
    state.attestation = result;
    out.replaceChildren(el('p', { class: 'status', text: `Nonce sent: ${nonce.slice(0, 16)}...` }));
    renderGroupedChecks(out, result.checks);
    out.append(el('div', { class: `verdict ${result.ok ? 'ok' : 'bad'}`, text: result.ok
      ? `The model key below is held inside verified confidential hardware, for ${state.config.model}.`
      : 'The hardware report did not pass every check. Nothing will be sent to this key.' }));
    if (result.tee) {
      out.append(el('dl', { class: 'kv' },
        el('dt', { text: 'Model' }), el('dd', { text: result.tee.model }),
        el('dt', { text: 'Model key' }), el('dd', { text: result.key ? `ed25519 ${result.key.publicKey}` : 'not trusted' }),
        el('dt', { text: 'TEE instance' }), el('dd', { text: result.tee.instanceId || '' }),
        el('dt', { text: 'Software hash' }), el('dd', { text: result.tee.composeHash || '' }),
      ));
    }
    if (result.ok) {
      state.key = result.key;
      $('step-tee').classList.add('done');
      const clear = state.gate?.status === 'clear';
      lock('step-brief', !clear);
      $('send').disabled = !clear;
    }
  } catch (e) {
    out.replaceChildren(el('p', { class: 'status error', text: `The check could not run: ${e.message}` }));
  } finally {
    button.disabled = state.gate?.status !== 'clear';
    button.textContent = 'Check again';
  }
}

// ---- Step 5: the brief ---------------------------------------------------------------------------------------

function resetBrief() {
  $('brief').replaceChildren();
  $('step-brief').classList.remove('done');
}

// NEAR AI Cloud records the signature a moment after the reply; retry a 404 a few times, about a second apart.
async function fetchSignature(id, standInHashes) {
  await new Promise((ok) => setTimeout(ok, standInHashes ? 0 : 1200));
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`api/signature/${encodeURIComponent(id)}${standInHashes ? `?hashes=${standInHashes}` : ''}`);
    if (r.status === 404) {
      await new Promise((ok) => setTimeout(ok, 1000));
      continue;
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `signature lookup failed (HTTP ${r.status})`);
    return data;
  }
  return { error_code: 'not_found', message: 'no signature was recorded for this reply' };
}

const TYPE_LABEL = { test: 'A test', evidence: 'Gather evidence', handover: 'Hand over now' };

function renderBrief(brief, classifications) {
  const nc = brief.next_check;
  const lead = brief.lead;
  return el('div', { class: 'brief' },
    classifications.length ? el('section', { class: 'gaps' },
      el('p', { class: 'overline', text: 'Variant classifications from the lab report' }),
      el('ul', {}, classifications.map(({ variant, classification, fact, source }) =>
        el('li', {}, el('strong', { text: variant }), ` · ${classification}`, factChips([fact]), el('div', { class: 'muted', text: source }))),
      )) : null,
    el('section', { class: 'next' },
      el('p', { class: 'overline' }, 'One next check · for a clinician to review', nc.type ? el('span', { class: `type ${nc.type}`, text: TYPE_LABEL[nc.type] || nc.type }) : null),
      el('h3', {}, nc.check || '(none given)'),
      el('p', {}, el('span', { class: 'muted', text: 'Why now: ' }), nc.why || '', factChips(nc.facts)),
      el('p', {}, el('span', { class: 'muted', text: 'What it cannot show: ' }), nc.cannot_show || '')),
    el('section', { class: 'lead' },
      el('p', { class: 'overline', text: lead ? `Leading explanation · ${lead.confidence || '?'} confidence · a possibility, not a diagnosis` : 'Leading explanation' }),
      lead ? el('p', {}, lead.explanation || '', factChips(lead.facts)) : el('p', { class: 'muted', text: 'None: the facts are too thin for a lead.' })),
    el('section', { class: 'gaps' },
      el('p', { class: 'overline', text: 'Gaps in the evidence' }),
      el('ul', {}, (Array.isArray(brief.gaps) ? brief.gaps : []).map((g) => el('li', {}, g?.gap || '', factChips(g?.facts))))),
  );
}

async function sendBrief() {
  const out = $('brief');
  const button = $('send');
  const c = state.case;
  if (!c || state.gate?.status !== 'clear') return;
  button.disabled = true;
  const live = state.config.inference === 'near-ai-cloud';
  const modelKey = live ? state.key.publicKey : state.config.standInKey;
  const signKey = live ? state.key : { algo: 'ed25519', publicKey: modelKey, address: modelKey, standIn: true };
  const status = el('p', { class: 'status' }, el('span', { class: 'spinner' }), live ? 'The model is reading the case inside the TEE...' : 'The stand-in is answering...');
  out.replaceChildren(status);
  try {
    const message = userMessage(c);
    const size = new TextEncoder().encode(message).length;
    if (size > MAX_USER_BYTES) throw new Error(`the case is ${fmtBytes(size)}, more than the ${fmtBytes(MAX_USER_BYTES)} the relay accepts`);
    const client = newClientKeys();
    const messages = encryptMessages(modelKey, client.publicKey, [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: message }]);
    const requestBytes = new TextEncoder().encode(JSON.stringify(briefBody(state.config.model, messages)));
    out.replaceChildren(
      el('details', {}, el('summary', { text: `What our server and NEAR's gateway see: ${fmtBytes(requestBytes.length)} of ciphertext` }),
        el('pre', { text: `${messages[1].content.slice(0, 600)}...` })),
      status,
    );
    const r = await fetch('api/brief', { method: 'POST', headers: { 'content-type': 'application/json', ...e2eeHeaders(client.publicKey, modelKey) }, body: requestBytes });
    const responseBytes = new Uint8Array(await r.arrayBuffer());
    if (!status.isConnected) return;
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        msg = JSON.parse(new TextDecoder().decode(responseBytes)).error?.message || msg;
      } catch { /* keep the status */ }
      throw new Error(msg);
    }
    const reply = JSON.parse(new TextDecoder().decode(responseBytes));
    const choice = reply.choices?.[0];
    const text = decryptWith(client.secretKey, choice?.message?.content || '');
    status.textContent = 'Decrypted on this device with a key made for this visit. Checking the brief and the signature...';
    const { brief, error } = parseBrief(text);
    if (choice?.finish_reason === 'length') out.append(el('p', { class: 'status error', text: 'The reply reached its length limit and may be cut off.' }));
    const checked = brief ? checkBrief(brief, c, state.gate) : { ok: false, checks: [{ id: 'shape', label: 'One JSON brief in the agreed shape', ok: false, detail: error }], flags: [] };
    out.append(el('h3', { class: 'group', text: 'Checks on the brief, on this page' }));
    renderChecks(out, checked.checks);
    for (const f of checked.flags) out.append(el('div', { class: 'flag', text: f.text }));
    const sig = await fetchSignature(reply.id, live ? null : `${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`);
    if (!status.isConnected) return;
    const v = verifyReplySignature({ sig, model: state.config.model, requestBytes, responseBytes, key: signKey });
    status.textContent = 'Decrypted on this device with a key made for this visit.';
    out.append(el('h3', { class: 'group', text: 'Was it signed inside the verified hardware?' }));
    renderChecks(out, v.checks);
    if (!live) out.append(el('div', { class: 'verdict bad', text: 'Stand-in mode: this server has no NEAR AI Cloud key, so the reply came from a local stand-in. Its key is not the attested one.' }));
    else out.append(el('div', { class: `verdict ${v.ok && checked.ok ? 'ok' : 'bad'}`, text: v.ok
      ? checked.ok ? 'Signed inside the verified hardware, for exactly this request, and the brief passed every check. A clinician still decides.' : 'Signed inside the verified hardware, but the brief failed a check above: do not use it.'
      : 'The signature check failed: do not trust this reply.' }));
    if (v.ok && checked.ok && choice?.finish_reason !== 'length') {
      status.after(
        renderBrief(brief, sourceClassifications(c)),
        el('details', {}, el('summary', { text: 'The decrypted reply, exactly as the model wrote it' }), el('pre', { text })),
      );
      if (live) $('step-brief').classList.add('done');
    } else {
      status.after(el('p', { class: 'status error', text: 'The reply failed verification. Review the numbered source facts above.' }));
    }
  } catch (e) {
    if (status.isConnected) out.append(el('p', { class: 'status error', text: `The brief failed: ${e.message}` }));
  } finally {
    if (status.isConnected) {
      button.disabled = state.gate?.status !== 'clear' || !state.key;
      button.textContent = 'Send again';
    }
  }
}

// ---- Start ---------------------------------------------------------------------------------------------------

async function start() {
  try {
    state.config = await api('api/config');
  } catch (e) {
    $('cases').replaceChildren(el('p', { class: 'status error', text: `The server is not reachable: ${e.message}` }));
    return;
  }
  if (state.config.inference !== 'near-ai-cloud') {
    const banner = $('mode-banner');
    banner.hidden = false;
    banner.replaceChildren(el('strong', { text: 'Stand-in mode. ' }), 'This server has no NEAR AI Cloud key. The hardware check still runs against NEAR AI Cloud, but the brief comes from a local stand-in with its own unattested key.');
  }
  $('cases').replaceChildren(...CASES.map((c) => {
    const b = el('button', { class: 'case', type: 'button', 'aria-pressed': 'false' },
      el('small', { class: 'shows', text: c.shows }), el('strong', { text: `${c.id}. ${c.title}` }), el('small', { text: c.setting }));
    b.addEventListener('click', () => pickCase(c, b));
    return b;
  }));
  $('check-tee').addEventListener('click', checkHardware);
  $('send').addEventListener('click', sendBrief);
}

start();
