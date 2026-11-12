// NEAR AI Cloud end-to-end encryption, version 3 (Ed25519 suite), written from the published protocol and checked
// against NEAR's own test vector (test/e2ee.test.mjs).
//
// Every message content is encrypted to the model's attested Ed25519 key, converted to X25519:
//   shared = X25519(fresh ephemeral secret, model key)
//   key    = HKDF-SHA256(shared, no salt, info "ed25519_encryption", 32 bytes)
//   wire   = hex( ephemeral public key (32) || nonce (24) || XChaCha20-Poly1305 ciphertext and tag )
// Version 3 adds associated data to each request field:
//   "nearai-e2ee-request-v3" || 0x02 || the client's Ed25519 public key (32) || 0x00 || field name
// so the ciphertext only decrypts for the reply key the browser chose. If anyone between the browser and the model
// swapped X-Client-Pub-Key for their own key (to read the reply), the model could not decrypt the request and
// would answer 400. The model encrypts its reply to the client key the same way, without associated data.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, randomBytes, cleanHex } from '../util/bytes.mjs';

export const E2EE_VERSION = '3';
export const E2EE_OVERHEAD = 32 + 24 + 16;
export const CONTENT_FIELD = 'messages[].content';
const INFO = utf8ToBytes('ed25519_encryption');
const V3_PREFIX = utf8ToBytes('nearai-e2ee-request-v3');
const ED25519_SUITE = 2;

/** A fresh Ed25519 key pair for one visit. The secret never leaves the page. */
export function newClientKeys() {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: bytesToHex(ed25519.getPublicKey(secretKey)) };
}

/** The v3 associated data for one request field. */
export function requestFieldAad(clientPubHex, field = CONTENT_FIELD) {
  const pub = hexToBytes(cleanHex(clientPubHex, 'client key'));
  if (pub.length !== 32) throw new Error('the client key must be 32 bytes');
  return concatBytes(V3_PREFIX, new Uint8Array([ED25519_SUITE]), pub, new Uint8Array([0]), utf8ToBytes(field));
}

const aeadKey = (shared) => hkdf(sha256, shared, undefined, INFO, 32);

/**
 * Encrypts text to an Ed25519 public key (hex) and returns the wire hex. `aad` is the field's associated data
 * (requests) or undefined (replies). `testOnly` fixes the ephemeral secret and nonce to reproduce a test vector.
 */
export function encryptTo(recipientEd25519PubHex, text, aad, testOnly = {}) {
  const recipient = ed25519.utils.toMontgomery(hexToBytes(cleanHex(recipientEd25519PubHex, 'recipient key')));
  const eph = testOnly.ephemeralSecret || x25519.utils.randomSecretKey();
  const nonce = testOnly.nonce || randomBytes(24);
  const shared = x25519.getSharedSecret(eph, recipient);
  const ct = xchacha20poly1305(aeadKey(shared), nonce, aad).encrypt(utf8ToBytes(text));
  return bytesToHex(concatBytes(x25519.getPublicKey(eph), nonce, ct));
}

/** Decrypts wire hex with an Ed25519 secret key. Throws if anything was changed or the key is wrong. */
export function decryptWith(ed25519SecretKey, wireHex, aad) {
  const data = hexToBytes(cleanHex(wireHex, 'ciphertext'));
  if (data.length < E2EE_OVERHEAD) throw new Error('ciphertext too short');
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(ed25519SecretKey), data.subarray(0, 32));
  const plain = xchacha20poly1305(aeadKey(shared), data.subarray(32, 56), aad).decrypt(data.subarray(56));
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

/** The messages for a request, every content encrypted to the model key and bound to the client key. */
export function encryptMessages(modelPubHex, clientPubHex, messages) {
  const aad = requestFieldAad(clientPubHex);
  return messages.map((m) => ({ role: m.role, content: encryptTo(modelPubHex, m.content, aad) }));
}

/** The headers NEAR AI Cloud needs for an encrypted request. */
export function e2eeHeaders(clientPubHex, modelPubHex) {
  return {
    'x-signing-algo': 'ed25519',
    'x-client-pub-key': clientPubHex,
    'x-model-pub-key': modelPubHex,
    'x-encryption-version': E2EE_VERSION,
    'x-encrypt-all-fields': 'true',
  };
}
