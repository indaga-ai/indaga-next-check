// Checks NEAR AI Cloud's hardware attestation for the model from this computer, with no key and no account:
//   npm run verify-tee            (MODEL=... to check another model)
// It makes a fresh random nonce, asks for a report bound to it, and runs the same checks as the web page,
// including Intel's signature over the TDX quote and NVIDIA's verdict on the GPU evidence.
import { verifyModelAttestation, newNonce } from '../src/tee/attestation.mjs';
import { quoteVerifier, gpuVerifier } from '../src/tee/hardware.mjs';
import { DEFAULT_MODEL } from '../src/ai/prompt.mjs';

const model = process.env.MODEL || DEFAULT_MODEL;
const base = process.env.NEARAI_BASE || 'https://cloud-api.near.ai/v1';
const nonce = newNonce();
const q = new URLSearchParams({ model, provider: 'near', signing_algo: 'ed25519', nonce, include_tls_fingerprint: 'false' });
console.log(`Asking ${base} for a hardware report on ${model}\nnonce ${nonce}\n`);
const r = await fetch(`${base}/attestation/report?${q}`, { headers: { 'x-no-aliasing': 'true' } });
if (!r.ok) {
  console.error(`HTTP ${r.status}`);
  process.exit(1);
}
const result = await verifyModelAttestation(await r.json(), { model, nonce, signingAlgo: 'ed25519', verifyQuote: quoteVerifier(), verifyGpu: gpuVerifier() });
for (const c of result.checks) {
  console.log(`${c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'SKIP'}  ${c.label}\n      ${c.detail}${c.where ? `  [${c.where}]` : ''}`);
}
if (result.tee) {
  console.log(`\nmodel key (ed25519): ${result.key?.publicKey ?? 'not trusted'}\nTEE instance: ${result.tee.instanceId}\nsoftware hash: ${result.tee.composeHash}`);
  for (const i of result.tee.images) console.log(`  image ${i.service ? `${i.service}: ` : ''}${i.image}`);
}
console.log(`\n${result.ok ? 'VERIFIED: this model key is held inside attested hardware (Intel TDX, NVIDIA confidential computing).' : 'NOT VERIFIED: do not send data to this key.'}`);
process.exit(result.ok ? 0 : 1);
