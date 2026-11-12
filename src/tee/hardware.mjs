// The two checks that need outside data: Intel's signature chain over a TDX quote, and NVIDIA's verdict on the GPU
// evidence. Neither trusts whoever carries the data:
// - Intel: dcap-qvl checks the quote against Intel's collateral (TCB info, QE identity, certificate revocation
//   lists), which Intel signs and dcap-qvl checks up to Intel's root certificate. In the browser the collateral is
//   fetched through our server (Intel's service does not allow browser requests); our server cannot forge it.
// - NVIDIA: NVIDIA's attestation service (NRAS) judges the GPU evidence and returns a JWT that NVIDIA signs, with
//   our nonce inside. The browser cannot call NRAS directly, so our server forwards the evidence; the JWT is then
//   checked against NVIDIA's public keys, which the browser fetches from NVIDIA itself.
import dcap from '@phala/dcap-qvl';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { bytesToHex, cleanHex } from '../util/bytes.mjs';

export const PHALA_PCCS = 'https://pccs.phala.network';
export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
export const NVIDIA_JWKS = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';
const NRAS_ISSUER = 'https://nras.attestation.nvidia.com';

// The TCB statuses NEAR AI's own SDK accepts by default. UpToDate is best; the other two mean Intel has published
// a newer platform patch or advises relaunching the TD, and are shown as such.
const ACCEPTED_TCB = new Set(['UpToDate', 'OutOfDate', 'TDRelaunchAdvised']);

/**
 * Returns verifyQuote(quoteBytes) for verifyModelAttestation.
 * Browser: { pccsUrl: '<origin>/api/pccs' }. Node: defaults to Phala's public PCCS.
 */
export function quoteVerifier({ pccsUrl = PHALA_PCCS, where } = {}) {
  const label = where || (pccsUrl === PHALA_PCCS ? 'this device (Intel collateral from a public PCCS)' : 'this device (Intel collateral relayed by our server; Intel-signed)');
  return async (quoteBytes) => {
    const collateral = await dcap.getCollateral(pccsUrl, quoteBytes);
    const vr = dcap.verify(quoteBytes, collateral, Math.floor(Date.now() / 1000));
    const td = vr.report.asTd10();
    const ok = ACCEPTED_TCB.has(vr.status) && Boolean(td);
    const advisories = vr.advisory_ids?.length ? `; advisories ${vr.advisory_ids.join(', ')}` : '';
    return {
      ok,
      status: vr.status,
      reportData: td ? bytesToHex(td.reportData) : null,
      detail: `Intel's certificate chain and signatures verify; platform patch level (TCB) ${vr.status}${advisories}.`,
      where: label,
    };
  };
}

/**
 * Returns verifyGpu(payload, nonce) for verifyModelAttestation.
 * Browser: { nrasUrl: '<origin>/api/nras' } (our server forwards the evidence unchanged); Node: NRAS directly.
 */
export function gpuVerifier({ nrasUrl = NRAS_URL, jwksUrl = NVIDIA_JWKS, fetchImpl = globalThis.fetch } = {}) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const relayed = nrasUrl !== NRAS_URL;
  return async (payload, nonce) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const r = await fetchImpl(nrasUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!r.ok) throw new Error(`NVIDIA attestation service answered HTTP ${r.status}`);
    const answer = await r.json();
    const token = Array.isArray(answer) && Array.isArray(answer[0]) && answer[0][0] === 'JWT' ? answer[0][1] : null;
    if (!token) throw new Error('no overall JWT in the NVIDIA answer');
    const { payload: claims, protectedHeader } = await jwtVerify(token, jwks, {
      algorithms: ['ES384'],
      issuer: NRAS_ISSUER,
      requiredClaims: ['exp', 'nbf', 'iat'],
    });
    const nonceOk = cleanHex(String(claims.eat_nonce || '')) === cleanHex(nonce);
    const verdict = claims['x-nvidia-overall-att-result'] === true;
    const gpus = Array.isArray(answer) ? answer.slice(1).reduce((n, o) => n + (o && typeof o === 'object' ? Object.keys(o).length : 0), 0) : 0;
    return {
      ok: nonceOk && verdict && Boolean(protectedHeader.kid),
      detail: `NVIDIA signed the verdict (ES384, key ${String(protectedHeader.kid).slice(0, 12)}...): overall result ${verdict}, our nonce ${nonceOk ? 'inside' : 'MISSING'}, ${gpus || 'unknown number of'} GPU(s).`,
      where: relayed ? 'NVIDIA attestation service, evidence relayed by our server; signature checked on this device' : 'NVIDIA attestation service; signature checked on this device',
    };
  };
}
