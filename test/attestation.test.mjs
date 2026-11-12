// The attestation checks on live NEAR AI Cloud reports (saved 7 Nov 2026), and on copies tampered one field at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyModelAttestation, ecdsaAddress } from '../src/tee/attestation.mjs';

const load = (algo) => JSON.parse(readFileSync(new URL(`./fixtures/attestation-${algo}.json`, import.meta.url), 'utf8'));
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));

for (const algo of ['ed25519', 'ecdsa']) {
  test(`a live ${algo} report passes every local check and yields the model key`, async () => {
    const f = load(algo);
    const r = await verifyModelAttestation(f.report, { model: f.model, nonce: f.nonce, signingAlgo: algo });
    const ids = byId(r);
    for (const id of ['model', 'nonce-echo', 'quote-format', 'not-debug', 'report-nonce', 'report-key', 'compose-bound', 'rtmr3', 'gpu-nonce']) {
      assert.equal(ids[id], true, `${id} should pass`);
    }
    assert.equal(ids.intel, null, 'Intel is "not checked" when no verifier is given');
    assert.equal(r.ok, true);
    assert.equal(r.key.algo, algo);
    assert.ok(r.tee.images.length > 0, 'the compose file names its images');
  });
}

test('a report for another nonce is refused', async () => {
  const f = load('ed25519');
  const other = 'ab'.repeat(32);
  const r = await verifyModelAttestation(f.report, { model: f.model, nonce: other, signingAlgo: 'ed25519' });
  const ids = byId(r);
  assert.equal(ids['nonce-echo'], false);
  assert.equal(ids['report-nonce'], false);
  assert.equal(ids['gpu-nonce'], false);
  assert.equal(r.ok, false);
});

test('a report without the requested model is refused', async () => {
  const f = load('ed25519');
  const r = await verifyModelAttestation(f.report, { model: 'some/other-model', nonce: f.nonce });
  assert.equal(r.ok, false);
  assert.equal(r.key, null);
});

const tamper = (f, fn) => {
  const copy = structuredClone(f.report);
  fn(copy.model_attestations.find((m) => m.model_name === f.model));
  return copy;
};

test('a changed software list breaks the compose and boot-log checks', async () => {
  const f = load('ed25519');
  const report = tamper(f, (m) => { m.info.tcb_info.app_compose = m.info.tcb_info.app_compose.replace('docker', 'dockeR'); });
  const ids = byId(await verifyModelAttestation(report, { model: f.model, nonce: f.nonce }));
  assert.equal(ids['compose-bound'], false);
  assert.equal(ids.rtmr3, false);
});

test('an edited boot-log event breaks the RTMR3 replay', async () => {
  const f = load('ed25519');
  const report = tamper(f, (m) => {
    const log = typeof m.event_log === 'string' ? JSON.parse(m.event_log) : m.event_log;
    const e = log.find((x) => x.imr === 3 && x.event === 'app-id');
    e.event_payload = e.event_payload.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    m.event_log = log;
  });
  assert.equal(byId(await verifyModelAttestation(report, { model: f.model, nonce: f.nonce })).rtmr3, false);
});

test('a swapped model key is refused (the quote binds a different key)', async () => {
  const f = load('ed25519');
  const report = tamper(f, (m) => { m.signing_public_key = 'cd'.repeat(32); m.signing_address = 'cd'.repeat(32); });
  const r = await verifyModelAttestation(report, { model: f.model, nonce: f.nonce });
  assert.equal(byId(r)['report-key'], false);
  assert.equal(r.key, null);
});

test('a quote with the DEBUG attribute is refused', async () => {
  const f = load('ed25519');
  const report = tamper(f, (m) => {
    const b = Buffer.from(m.intel_quote, 'hex');
    b[168] |= 1;
    m.intel_quote = b.toString('hex');
  });
  assert.equal(byId(await verifyModelAttestation(report, { model: f.model, nonce: f.nonce }))['not-debug'], false);
});

test('a failing Intel or NVIDIA verdict fails the whole check', async () => {
  const f = load('ed25519');
  const r = await verifyModelAttestation(f.report, {
    model: f.model, nonce: f.nonce,
    verifyQuote: async () => ({ ok: false, status: 'Revoked' }),
    verifyGpu: async () => ({ ok: true, detail: 'fine' }),
  });
  assert.equal(r.ok, false);
});

test('ecdsaAddress matches the address NEAR reports for its key', () => {
  const f = load('ecdsa');
  const m = f.report.model_attestations[0];
  assert.equal(ecdsaAddress(m.signing_public_key), m.signing_address.toLowerCase());
});

test('the gateway attestation is checked too, and a tampered one fails the whole check', async () => {
  const f = load('ed25519');
  const good = await verifyModelAttestation(f.report, { model: f.model, nonce: f.nonce });
  assert.equal(byId(good).gateway, true);
  const report = structuredClone(f.report);
  report.gateway_attestation.info.tcb_info.app_compose += ' ';
  const bad = await verifyModelAttestation(report, { model: f.model, nonce: f.nonce });
  assert.equal(byId(bad).gateway, false);
  assert.equal(bad.ok, false);
});
