// A stand-in for the model, used when the server has no NEAR AI Cloud key, so anyone can run the whole flow.
// Adapted from DNA Confidential's. It speaks the same protocol: it decrypts the request with its own Ed25519 key,
// answers with a fixed brief that says no model read the case, encrypts the reply to the browser's key and signs
// the exchange. It has NO hardware attestation, and the page says so: its key is not the attested model key.
import { ed25519 } from '@noble/curves/ed25519.js';
import { decryptWith, encryptTo, requestFieldAad } from '../src/tee/e2ee.mjs';
import { signedText } from '../src/tee/signature.mjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes, randomBytes, concatBytes } from '../src/util/bytes.mjs';

export class StandIn {
  // With a seed, every serverless instance derives the same stand-in key, so a request can land on any instance.
  constructor(model, seed) {
    this.model = model;
    this.secretKey = seed ? sha256(concatBytes(seed, utf8ToBytes('stand-in-key-v1'))) : ed25519.utils.randomSecretKey();
    this.publicKey = bytesToHex(ed25519.getPublicKey(this.secretKey));
    this.signatures = new Map();
  }

  /** A fixed brief in the agreed shape. It cites the case's facts but reads none of them. */
  reply(userText) {
    const facts = userText.split('\n').map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter((x) => x && Number.isInteger(x.n));
    const all = facts.map((f) => f.n);
    const cite = all.length ? all : [1];
    return JSON.stringify({
      lead: null,
      gaps: [{ gap: `Stand-in mode: no model read these ${all.length} facts.`, facts: cite }],
      next_check: {
        type: 'evidence',
        check: 'Run the app with a NEAR AI Cloud key, so that the attested model writes the brief.',
        why: 'This server has no key, so a local template answered instead of a model.',
        facts: cite,
        cannot_show: 'Anything about this case: no model read it.',
      },
    });
  }

  async chat(rawBytes, headers) {
    const err = (status, message) => ({ status, bytes: Buffer.from(JSON.stringify({ error: { message, type: 'e2ee_error' } })) });
    if (headers['x-model-pub-key'] !== this.publicKey) return err(400, 'X-Model-Pub-Key is not this model\'s key');
    let messages;
    try {
      const body = JSON.parse(Buffer.from(rawBytes).toString('utf8'));
      // Version 3: each field is bound to the client key in X-Client-Pub-Key; a swapped key fails here.
      const aad = requestFieldAad(headers['x-client-pub-key']);
      messages = body.messages.map((m) => ({ role: m.role, content: decryptWith(this.secretKey, m.content, aad) }));
    } catch {
      return err(400, 'could not decrypt the request');
    }
    const id = `chatcmpl-standin-${bytesToHex(randomBytes(12))}`;
    const text = this.reply(messages.find((m) => m.role === 'user')?.content || '');
    const response = {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, message: { role: 'assistant', content: encryptTo(headers['x-client-pub-key'], text) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const bytes = Buffer.from(JSON.stringify(response));
    const signed = signedText(this.model, rawBytes, bytes);
    this.signatures.set(id, {
      text: signed,
      signature: bytesToHex(ed25519.sign(utf8ToBytes(signed), this.secretKey)),
      signing_address: this.publicKey,
      signing_algo: 'ed25519',
      signature_kind: 'provider_tee',
    });
    if (this.signatures.size > 500) this.signatures.delete(this.signatures.keys().next().value);
    return { status: 200, bytes };
  }

  /**
   * The stored signature, or, when the reply was made on another serverless instance, a fresh one over the hashes
   * the page sends. That makes the stand-in sign whatever hashes it is given; harmless, because its key is not
   * attested and the page labels everything it signs as the stand-in's.
   */
  signature(id, hashes) {
    let s = this.signatures.get(id);
    if (!s && /^chatcmpl-standin-[0-9a-f]{24}$/.test(id) && /^[0-9a-f]{64}:[0-9a-f]{64}$/.test(hashes || '')) {
      const text = `${this.model}:${hashes}`;
      s = { text, signature: bytesToHex(ed25519.sign(utf8ToBytes(text), this.secretKey)), signing_address: this.publicKey, signing_algo: 'ed25519', signature_kind: 'provider_tee' };
    }
    return s ? { status: 200, bytes: Buffer.from(JSON.stringify(s)) } : { status: 404, bytes: Buffer.from(JSON.stringify({ error: { message: 'not found' } })) };
  }
}
