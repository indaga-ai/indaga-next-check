// Encryption: NEAR's published v3 test vector, the round trip, and that tampering, the wrong key or a swapped
// reply key is detected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encryptTo, decryptWith, newClientKeys, encryptMessages, requestFieldAad, E2EE_OVERHEAD, CONTENT_FIELD } from '../src/tee/e2ee.mjs';
import { bytesToHex, hexToBytes } from '../src/util/bytes.mjs';

// From NEAR AI's inference-sdk (MIT), test-fixtures/e2ee-v3.json, Ed25519 suite: public deterministic test keys.
const vector = JSON.parse(readFileSync(new URL('./fixtures/e2ee-v3-ed25519.json', import.meta.url), 'utf8'));

test('reproduces NEAR\'s v3 test vector byte for byte', () => {
  assert.equal(bytesToHex(ed25519.getPublicKey(hexToBytes(vector.model_secret))), vector.model_public);
  assert.equal(bytesToHex(ed25519.getPublicKey(hexToBytes(vector.reply_secret))), vector.reply_public);
  const aad = requestFieldAad(vector.reply_public, vector.field);
  assert.equal(bytesToHex(aad), vector.aad);
  const wire = encryptTo(vector.model_public, vector.plaintext, aad, {
    ephemeralSecret: hexToBytes(vector.ephemeral_secret),
    nonce: hexToBytes(vector.nonce),
  });
  assert.equal(wire, vector.ciphertext);
  assert.equal(decryptWith(hexToBytes(vector.model_secret), vector.ciphertext, aad), vector.plaintext);
});

test('round trip, and the size is text + 72 bytes', () => {
  const model = newClientKeys();
  const text = 'Traits:\n{"trait":"Earwax type","genotype":"CT"}';
  const wire = encryptTo(model.publicKey, text);
  assert.equal(wire.length, 2 * (E2EE_OVERHEAD + new TextEncoder().encode(text).length));
  assert.equal(decryptWith(model.secretKey, wire), text);
  assert.equal(decryptWith(model.secretKey, encryptTo(model.publicKey, 'é ü 中')), 'é ü 中');
});

test('each encryption uses a fresh ephemeral key and nonce', () => {
  const k = newClientKeys();
  assert.notEqual(encryptTo(k.publicKey, 'same'), encryptTo(k.publicKey, 'same'));
});

test('a flipped byte or another key fails to decrypt', () => {
  const k = newClientKeys();
  const wire = encryptTo(k.publicKey, 'secret genotype');
  const flipped = wire.slice(0, -2) + (wire.endsWith('00') ? '01' : '00');
  assert.throws(() => decryptWith(k.secretKey, flipped));
  assert.throws(() => decryptWith(newClientKeys().secretKey, wire));
});

test('v3: a request bound to one reply key cannot be decrypted as if bound to a swapped key', () => {
  const model = newClientKeys();
  const browser = newClientKeys();
  const relay = newClientKeys();
  const [msg] = encryptMessages(model.publicKey, browser.publicKey, [{ role: 'user', content: 'genotypes' }]);
  assert.equal(decryptWith(model.secretKey, msg.content, requestFieldAad(browser.publicKey)), 'genotypes');
  assert.throws(() => decryptWith(model.secretKey, msg.content, requestFieldAad(relay.publicKey)));
  assert.throws(() => decryptWith(model.secretKey, msg.content, requestFieldAad(browser.publicKey, 'messages[].name')));
  assert.equal(CONTENT_FIELD, 'messages[].content');
});
