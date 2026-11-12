// Checks NEAR AI Cloud's signature over one exchange. The signed text is
//   <model>:<SHA-256 of the exact request body>:<SHA-256 of the exact response body>
// signed by the model's attested key, so a valid signature ties this reply to this request and to the TEE.
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, cleanHex } from '../util/bytes.mjs';

export const sha256Hex = (bytes) => bytesToHex(sha256(typeof bytes === 'string' ? utf8ToBytes(bytes) : bytes));

export function signedText(model, requestBytes, responseBytes) {
  return `${model}:${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
}

function verifyEd25519(pubHex, text, sigHex) {
  try {
    return ed25519.verify(hexToBytes(cleanHex(sigHex)), utf8ToBytes(text), hexToBytes(cleanHex(pubHex)));
  } catch {
    return false;
  }
}

/** EIP-191 personal-sign recovery: the address that signed `text`, or null. */
export function recoverEcdsaAddress(text, sigHex) {
  try {
    const sig = hexToBytes(cleanHex(sigHex));
    if (sig.length !== 65) return null;
    const msg = utf8ToBytes(text);
    const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
    const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    const recovered = secp256k1.recoverPublicKey(concatBytes(new Uint8Array([v]), sig.subarray(0, 64)), digest, { prehash: false });
    const point = secp256k1.Point.fromBytes(recovered).toBytes(false).subarray(1);
    return `0x${bytesToHex(keccak_256(point).subarray(12))}`;
  } catch {
    return null;
  }
}

/**
 * @param sig   the JSON from GET /v1/signature/{id}: { text, signature, signing_address, signing_algo, signature_kind }
 * @param key   the attested model key: { algo, publicKey, address }
 * Only a "provider_tee" signature counts: it is made inside the model's TEE with the attested key. A "gateway"
 * signature is NEAR's gateway vouching, which is not the same thing.
 */
export function verifyReplySignature({ sig, model, requestBytes, responseBytes, key }) {
  const checks = [];
  if (sig && sig.error_code) {
    checks.push({ id: 'sig-available', label: 'A signature is available for this reply', ok: false, detail: `NEAR AI Cloud says: ${sig.error_code}${sig.message ? ` (${sig.message})` : ''}` });
    return { ok: false, checks };
  }
  const expected = signedText(model, requestBytes, responseBytes);
  checks.push({
    id: 'sig-text', label: 'The signature covers this exact request and reply', ok: sig?.text === expected,
    detail: 'The signed text is the model name and the SHA-256 of the request and reply bytes exactly as this page sent and received them (ciphertext included).',
  });
  const kindOk = sig?.signature_kind === 'provider_tee';
  const signerOk = Boolean(key) && sig?.signing_algo === key.algo && String(sig?.signing_address || '').toLowerCase() === String(key.address).toLowerCase();
  let valid = false;
  if (kindOk && signerOk && key.algo === 'ed25519') valid = verifyEd25519(key.publicKey, String(sig.text ?? ''), sig.signature ?? '');
  else if (kindOk && signerOk && key.algo === 'ecdsa') valid = recoverEcdsaAddress(String(sig.text ?? ''), sig.signature ?? '') === key.address;
  checks.push({
    id: 'sig-key', label: key?.standIn ? 'The stand-in\'s own key signed it (no hardware behind it)' : 'The attested model key signed it, inside the TEE', ok: valid,
    detail: !kindOk ? `signature kind is "${sig?.signature_kind ?? 'missing'}", not the model TEE's own ("provider_tee")`
      : !signerOk ? 'the signer is not the key the hardware vouched for'
        : `Ed25519 signature verified against ${key.standIn ? 'the stand-in key' : 'the attested key'} ${String(key.publicKey).slice(0, 16)}...`,
  });
  return { ok: checks.every((c) => c.ok), checks };
}
