// Checks a NEAR AI Cloud attestation report for one model, so the browser can decide whether to trust the key
// it is about to encrypt to. Every check is listed with what it proves; nothing is skipped silently.
//
// The quote's 64-byte report_data is the binding: bytes 0-31 are the model's signing key (ed25519: the 32-byte
// public key; ecdsa: the 20-byte address plus 12 zero bytes), bytes 32-63 are the nonce we chose. Checked against
// live reports on 7 Nov 2026.
//
// Two checks need outside code and are passed in, so the same function runs in the browser, in Node and in tests:
//   verifyQuote(quoteBytes) -> { ok, status, detail }   Intel's signature chain over the TDX quote (dcap-qvl)
//   verifyGpu(nvidiaPayload, nonce) -> { ok, detail }  NVIDIA's verdict on the GPU evidence (NRAS)
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { parseTdxQuote } from './tdx-quote.mjs';
import { replayRtmr, runtimeEvent } from './event-log.mjs';
import { composeHash, expectedMrConfigId, composeImages } from './compose.mjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, equalBytes, cleanHex, utf8ToBytes } from '../util/bytes.mjs';

export function newNonce() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** The Ethereum-style address of an uncompressed secp256k1 public key (64 bytes, or 65 with the 0x04 prefix). */
export function ecdsaAddress(publicKey) {
  let pk = typeof publicKey === 'string' ? hexToBytes(cleanHex(publicKey, 'public key')) : publicKey;
  if (pk.length === 65 && pk[0] === 4) pk = pk.subarray(1);
  if (pk.length !== 64) throw new Error('expected a 64-byte uncompressed secp256k1 key');
  secp256k1.Point.fromBytes(new Uint8Array([4, ...pk])); // throws if the point is not on the curve
  return `0x${bytesToHex(keccak_256(pk).subarray(12))}`;
}

/**
 * The compose-manager's action log, serialised the way it hashes it (Rust serde_json::to_string over records whose
 * keys are sorted): compact JSON, keys in byte order, string or string-list values.
 */
export function canonicalActions(actions) {
  const value = (v) => JSON.stringify(v);
  return `[${actions.map((a) => `{${Object.keys(a).sort().map((k) => `${JSON.stringify(k)}:${value(a[k])}`).join(',')}}`).join(',')}]`;
}

/** Checks the compose-manager attestation: the log of what was deployed in this TEE, bound to our nonce. */
async function checkComposeManager(checks, cm, { wantNonce, appCompose, verifyQuote }) {
  if (!cm) {
    check(checks, 'deploy-log', 'The deployment log is attested', null, 'no compose-manager attestation in this report');
    return null;
  }
  const problems = [];
  if (cm.nonce !== wantNonce || cm.nonce_source !== 'client') problems.push('it does not answer our nonce');
  const actions = Array.isArray(cm.actions) ? cm.actions : [];
  const hash = bytesToHex(sha256(utf8ToBytes(canonicalActions(actions))));
  if (hash !== cleanHex(cm.actions_hash || '')) problems.push('the log does not hash to its actions_hash');
  let q = null;
  try {
    q = parseTdxQuote(cm.quote);
  } catch (e) {
    problems.push(`its quote is unreadable (${e.message})`);
  }
  if (q) {
    if (bytesToHex(q.reportData.subarray(0, 32)) !== hash || bytesToHex(q.reportData.subarray(32)) !== wantNonce) problems.push('its quote does not bind the log hash and our nonce');
    if (!appCompose || bytesToHex(q.mrConfigId) !== expectedMrConfigId(appCompose)) problems.push('it was not measured with the same configuration as the model');
    try {
      if (!equalBytes(replayRtmr(cm.event_log, 3), q.rtmr3)) problems.push('its boot log does not replay');
    } catch {
      problems.push('its boot log is unreadable');
    }
    if (q.debug) problems.push('its TEE is in debug mode');
    if (verifyQuote && !problems.length) {
      try {
        const r = await verifyQuote(q.bytes);
        if (!r.ok) problems.push(`Intel did not accept its quote (${r.status})`);
      } catch (e) {
        problems.push(`its quote could not be checked with Intel (${e.message})`);
      }
    }
  }
  const ups = actions.filter((a) => a.action === 'compose_up');
  const last = ups[ups.length - 1] || null;
  check(checks, 'deploy-log', 'The deployment log is attested', problems.length === 0,
    problems.length ? `Not trusted: ${problems.join('; ')}.`
      : `${actions.length} logged actions, bound to our nonce by a quote from the same measured configuration${verifyQuote ? ' and verified with Intel' : ''}. Latest deployment: ${last ? `${last.file} at ${String(last.commit || '').slice(0, 10)} (${last.tag || 'no tag'}, ${last.timestamp?.slice(0, 10)})` : 'none'}.`);
  return { actions, latestComposeUp: last, ok: problems.length === 0 };
}

function check(list, id, label, ok, detail, where = 'this device') {
  list.push({ id, label, ok: ok === true ? true : ok === false ? false : null, detail, where });
  return ok === true;
}

/**
 * NEAR's gateway, which routes the request, runs in a TEE too. It only ever sees ciphertext, so this is not what
 * protects the genotypes; it is checked the same way (nonce, key binding, software list, boot log, Intel) because
 * NEAR's own SDK does, and a failure here is reported like any other.
 */
export async function verifyGatewayAttestation(gw, { nonce, verifyQuote }) {
  const want = cleanHex(nonce, 'nonce');
  const problems = [];
  if (!gw) return { ok: false, detail: 'no gateway attestation in the report' };
  if (gw.request_nonce !== want) problems.push('it does not answer our nonce');
  let q = null;
  try {
    q = parseTdxQuote(gw.intel_quote);
  } catch (e) {
    problems.push(`its quote is unreadable (${e.message})`);
  }
  if (q) {
    const rd = bytesToHex(q.reportData);
    if (gw.report_data && cleanHex(gw.report_data) !== rd) problems.push('its report_data field differs from its quote');
    if (rd.slice(64) !== want) problems.push('its quote does not hold our nonce');
    const id = cleanHex(String(gw.signing_address || ''));
    const bound = gw.signing_algo === 'ed25519' ? rd.slice(0, 64) === id : rd.slice(0, 64) === id.padEnd(64, '0');
    if (!bound) problems.push('its quote does not bind its signing key');
    if (q.debug) problems.push('it is in debug mode');
    const compose = gw.info?.tcb_info?.app_compose || '';
    if (!compose || bytesToHex(q.mrConfigId) !== expectedMrConfigId(compose)) problems.push('its software list is not the measured one');
    try {
      if (!equalBytes(replayRtmr(gw.event_log, 3), q.rtmr3)) problems.push('its boot log does not replay');
    } catch {
      problems.push('its boot log is unreadable');
    }
    if (verifyQuote && !problems.length) {
      try {
        const r = await verifyQuote(q.bytes);
        if (!r.ok) problems.push(`Intel did not accept its quote (${r.status})`);
      } catch (e) {
        problems.push(`its quote could not be checked with Intel (${e.message})`);
      }
    }
  }
  return {
    ok: problems.length === 0,
    detail: problems.length ? `Not trusted: ${problems.join('; ')}.` : `Nonce, key binding, software list and boot log check out${verifyQuote ? ', and Intel signed its quote' : ''}. It routes ciphertext only.`,
  };
}

/**
 * @param report   the JSON from GET /v1/attestation/report
 * @param opts     { model, nonce, signingAlgo: 'ed25519' | 'ecdsa', verifyQuote?, verifyGpu? }
 * @returns { ok, checks[], key: { algo, publicKey, address }, tee: { instanceId, composeHash, images, ... } }
 */
export async function verifyModelAttestation(report, opts) {
  const { model, nonce, signingAlgo = 'ed25519', verifyQuote, verifyGpu } = opts;
  const checks = [];
  const wantNonce = cleanHex(nonce, 'nonce');

  const entries = Array.isArray(report?.model_attestations) ? report.model_attestations : [];
  const att = entries.find((m) => m.model_name === model);
  if (!check(checks, 'model', `The report covers ${model}`, Boolean(att), att ? `${entries.length} model attestation(s) in the report` : 'no attestation for this model')) {
    return { ok: false, checks, key: null, tee: null };
  }

  check(checks, 'nonce-echo', 'The report answers our fresh nonce', att.request_nonce === wantNonce,
    'A new random nonce is chosen for every check, so an old report cannot be replayed.');

  let quote;
  try {
    quote = parseTdxQuote(att.intel_quote);
    check(checks, 'quote-format', 'The quote is an Intel TDX quote', true, `version ${quote.version}, TEE type 0x${quote.teeType.toString(16)}`);
  } catch (e) {
    check(checks, 'quote-format', 'The quote is an Intel TDX quote', false, e.message);
    return { ok: false, checks, key: null, tee: null };
  }
  check(checks, 'not-debug', 'The TEE is not in debug mode', !quote.debug,
    quote.debug ? 'DEBUG is set: the host could read the TEE memory.' : 'TD attribute DEBUG is off, so the host cannot read the TEE memory.');

  const rd = quote.reportData;
  check(checks, 'report-nonce', 'The hardware signed our nonce', bytesToHex(rd.subarray(32)) === wantNonce,
    'Bytes 32-63 of the quote report_data equal the nonce.');

  // The key the model signs with (and, for ed25519, the key we encrypt to).
  let key = null;
  if (signingAlgo === 'ed25519') {
    const pub = cleanHex(att.signing_public_key || att.signing_address || '', 'signing key');
    const ok = pub.length === 64 && bytesToHex(rd.subarray(0, 32)) === pub;
    check(checks, 'report-key', 'The hardware signed the model key', ok,
      `Bytes 0-31 of report_data equal the model's Ed25519 public key ${pub.slice(0, 16)}...`);
    if (ok) key = { algo: 'ed25519', publicKey: pub, address: pub };
  } else {
    const address = String(att.signing_address || '').toLowerCase();
    let derived = null;
    try {
      derived = ecdsaAddress(att.signing_public_key);
    } catch {
      derived = null;
    }
    const ok = derived === address && equalBytes(rd.subarray(0, 20), hexToBytes(cleanHex(address))) && rd.subarray(20, 32).every((b) => b === 0);
    check(checks, 'report-key', 'The hardware signed the model key', ok,
      `report_data starts with the signing address ${address}, which is the hash of the reported public key.`);
    if (ok) key = { algo: 'ecdsa', publicKey: cleanHex(att.signing_public_key), address };
  }

  // What software runs: app_compose bound by MRCONFIGID and by the RTMR3 event log.
  const tcb = att.info?.tcb_info || {};
  const appCompose = typeof tcb.app_compose === 'string' ? tcb.app_compose : '';
  const cHash = appCompose ? composeHash(appCompose) : null;
  check(checks, 'compose-bound', 'The software list is the one the hardware measured',
    Boolean(appCompose) && bytesToHex(quote.mrConfigId) === expectedMrConfigId(appCompose),
    'MRCONFIGID = 0x01 || SHA-256(app_compose): the docker-compose file below is exactly what this TEE was started with.');

  let rtmrOk = false;
  let composeEvent = null;
  try {
    const replayed = replayRtmr(att.event_log, 3);
    composeEvent = runtimeEvent(att.event_log, 'compose-hash');
    rtmrOk = equalBytes(replayed, quote.rtmr3) && composeEvent === cHash;
  } catch {
    rtmrOk = false;
  }
  check(checks, 'rtmr3', 'The boot log matches the hardware measurement', rtmrOk,
    'Replaying the runtime event log gives the quote\'s RTMR3, and its compose-hash event names the same compose file.');

  // Intel's signature over the quote (passed in: dcap-qvl in the browser or Node).
  if (verifyQuote) {
    try {
      const r = await verifyQuote(quote.bytes);
      check(checks, 'intel', 'Intel signed this quote', r.ok, r.detail || r.status, r.where || 'this device');
    } catch (e) {
      check(checks, 'intel', 'Intel signed this quote', false, `could not verify: ${e.message}`);
    }
  } else {
    check(checks, 'intel', 'Intel signed this quote', null, 'not checked here');
  }

  const deployLog = await checkComposeManager(checks, att.compose_manager_attestation, { wantNonce, appCompose, verifyQuote });

  // NVIDIA GPU evidence: it must answer our nonce, then NVIDIA's service judges it.
  let gpu = null;
  try {
    gpu = typeof att.nvidia_payload === 'string' ? JSON.parse(att.nvidia_payload) : att.nvidia_payload;
  } catch {
    gpu = null;
  }
  check(checks, 'gpu-nonce', 'The GPU evidence answers our nonce', Boolean(gpu) && cleanHex(gpu.nonce || '') === wantNonce,
    gpu ? `${(gpu.evidence_list || []).length} GPU(s), ${gpu.arch || (gpu.evidence_list?.[0]?.arch ?? 'unknown arch')}` : 'no GPU evidence in the report');
  if (verifyGpu && gpu) {
    try {
      const r = await verifyGpu(gpu, wantNonce);
      check(checks, 'nvidia', 'NVIDIA confirms the GPU runs in confidential mode', r.ok, r.detail, r.where || 'NVIDIA attestation service');
    } catch (e) {
      check(checks, 'nvidia', 'NVIDIA confirms the GPU runs in confidential mode', false, `could not verify: ${e.message}`);
    }
  } else {
    check(checks, 'nvidia', 'NVIDIA confirms the GPU runs in confidential mode', null, 'not checked here');
  }

  const gateway = await verifyGatewayAttestation(report.gateway_attestation, { nonce: wantNonce, verifyQuote });
  check(checks, 'gateway', 'NEAR\'s gateway runs in a TEE too', gateway.ok, gateway.detail);

  const required = ['model', 'nonce-echo', 'quote-format', 'not-debug', 'report-nonce', 'report-key', 'compose-bound', 'rtmr3', 'gpu-nonce'];
  const ok = required.every((id) => checks.find((c) => c.id === id)?.ok === true)
    && checks.filter((c) => c.ok === false).length === 0;

  return {
    ok,
    checks,
    key,
    tee: {
      model,
      instanceId: att.info?.instance_id || null,
      appId: att.info?.app_id || null,
      appName: att.info?.app_name || null,
      composeHash: cHash,
      osImageHash: tcb.os_image_hash || null,
      images: appCompose ? composeImages(appCompose) : [],
      deployLog,
      mrTd: bytesToHex(quote.mrTd),
    },
  };
}
