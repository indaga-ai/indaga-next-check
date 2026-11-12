// The relay (adapted from DNA Confidential's test): the fixed request shape, rate limits, the key staying
// server-side, and a whole encrypted exchange through the stand-in model (same protocol as NEAR AI Cloud, minus the
// hardware), ending in a brief that passes the page's checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler, checkBriefShape } from '../server/handler.mjs';
import { StandIn } from '../server/stand-in.mjs';
import { RateLimiter } from '../server/ratelimit.mjs';
import { SYSTEM_PROMPT, userMessage, MAX_USER_BYTES, briefBody, DEFAULT_MODEL } from '../src/ai/prompt.mjs';
import { newClientKeys, encryptMessages, encryptTo, decryptWith, requestFieldAad, e2eeHeaders } from '../src/tee/e2ee.mjs';
import { verifyReplySignature } from '../src/tee/signature.mjs';
import { parseBrief, checkBrief } from '../src/ai/brief.mjs';
import { caseById } from '../src/cases/cases.mjs';

const MODEL = DEFAULT_MODEL;
const CLIENT = newClientKeys();
const CASE = caseById('A');
const body = (key, over = {}, client = CLIENT.publicKey) => ({
  ...briefBody(MODEL, encryptMessages(key, client, [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMessage(CASE) }])),
  ...over,
});
const enc = (key, text) => encryptTo(key, text, requestFieldAad(CLIENT.publicKey));

test('the fixed shape passes', () => {
  assert.doesNotThrow(() => checkBriefShape(body(newClientKeys().publicKey), { model: MODEL }));
});

test('anything else is refused', () => {
  const k = newClientKeys().publicKey;
  const bad = {
    'an extra field': body(k, { tools: [] }),
    'another model': body(k, { model: 'openai/gpt-5' }),
    'more tokens': body(k, { max_tokens: 4000 }),
    'streaming': body(k, { stream: true }),
    'a third message': { ...body(k), messages: [...body(k).messages, { role: 'user', content: enc(k, 'hi') }] },
    'another reasoning setting': body(k, { reasoning_effort: 'high' }),
    'a missing model setting': (() => { const b = body(k); delete b.reasoning_effort; return b; })(),
    'plain text': { ...body(k), messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'hello' }] },
    'other instructions': { ...body(k), messages: [{ role: 'system', content: enc(k, 'You are a helpful assistant.') }, body(k).messages[1]] },
    'an oversized case': { ...body(k), messages: [body(k).messages[0], { role: 'user', content: enc(k, 'x'.repeat(MAX_USER_BYTES + 1)) }] },
    'roles swapped': { ...body(k), messages: [...body(k).messages].reverse() },
  };
  for (const [name, b] of Object.entries(bad)) {
    assert.throws(() => checkBriefShape(b, { model: MODEL }), (e) => e.status === 400, name);
  }
});

test('rate limits: per address per hour, per day, and for the whole server', () => {
  let t = 0;
  const rl = new RateLimiter({ perHour: 2, perDay: 3, globalPerDay: 4 }, () => t);
  rl.take('a');
  rl.take('a');
  assert.throws(() => rl.take('a'), (e) => e.code === 'limit_hour');
  t += 3_600_001;
  rl.take('a');
  assert.throws(() => rl.take('a'), (e) => e.code === 'limit_day');
  rl.take('b');
  assert.throws(() => rl.take('c'), (e) => e.code === 'busy_today');
});

let server;
let base;
const standIn = new StandIn(MODEL);
const KEY = 'test-key-0000-must-never-leave-the-server';
before(async () => {
  const handler = createHandler({ model: MODEL, standIn, apiKey: '', fetch: async () => { throw new Error('no network in tests'); } });
  server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('a whole exchange: encrypted case, encrypted brief that passes the page checks, valid signature over both', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.inference, 'stand-in');
  assert.equal(cfg.standInKey, standIn.publicKey);
  const client = newClientKeys();
  const reqBytes = new TextEncoder().encode(JSON.stringify(body(cfg.standInKey, {}, client.publicKey)));
  assert.doesNotMatch(new TextDecoder().decode(reqBytes), /creatine|exon|paediatrician/i, 'the request carries no fact in plain text');
  const r = await fetch(`${base}/api/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...e2eeHeaders(client.publicKey, cfg.standInKey) },
    body: reqBytes,
  });
  assert.equal(r.status, 200);
  const respBytes = new Uint8Array(await r.arrayBuffer());
  const reply = JSON.parse(new TextDecoder().decode(respBytes));
  const text = decryptWith(client.secretKey, reply.choices[0].message.content);
  const { brief, error } = parseBrief(text);
  assert.equal(error, null);
  assert.match(brief.gaps[0].gap, /Stand-in mode/);
  assert.equal(checkBrief(brief, CASE).ok, true);
  const sig = await (await fetch(`${base}/api/signature/${reply.id}`)).json();
  const key = { algo: 'ed25519', publicKey: cfg.standInKey, address: cfg.standInKey };
  assert.equal(verifyReplySignature({ sig, model: MODEL, requestBytes: reqBytes, responseBytes: respBytes, key }).ok, true);
  const changed = respBytes.slice();
  changed[changed.length - 5] ^= 1;
  assert.equal(verifyReplySignature({ sig, model: MODEL, requestBytes: reqBytes, responseBytes: changed, key }).ok, false, 'the signature does not cover a changed reply');
});

test('v3: a request whose reply key was swapped on the way is refused by the model', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  const browser = newClientKeys();
  const relay = newClientKeys();
  const r = await fetch(`${base}/api/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...e2eeHeaders(relay.publicKey, cfg.standInKey) },
    body: JSON.stringify(body(cfg.standInKey, {}, browser.publicKey)),
  });
  assert.equal(r.status, 400);
});

test('a request encrypted to another key is refused by the model', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  const other = newClientKeys().publicKey;
  assert.notEqual(cfg.standInKey, other);
  const r = await fetch(`${base}/api/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-pub-key': newClientKeys().publicKey, 'x-model-pub-key': other },
    body: JSON.stringify(body(other)),
  });
  assert.equal(r.status, 400);
});

test('the API key never reaches the browser', async () => {
  const handler = createHandler({ model: MODEL, standIn, apiKey: KEY, fetch: async () => new Response('{}', { status: 200 }) });
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const text = await (await fetch(`${b}/api/config`)).text();
  s.close();
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes('test-key'));
});

test('static files: the page is served with its security policy, and paths outside web/ are refused', async () => {
  const handler = createHandler({ model: MODEL, standIn, staticRoot: fileURLToPath(new URL('../web/', import.meta.url)) });
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const page = await fetch(`${b}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/nras\.attestation\.nvidia\.com;/);
  for (const p of ['/..%2Fpackage.json', '/%2e%2e/package.json', '/fonts/..%2F..%2Fpackage.json']) {
    const r = await fetch(`${b}${p}`);
    assert.ok([403, 404].includes(r.status), `${p} gave ${r.status}`);
  }
  s.close();
});

test('stand-in with a seed: the same seed gives the same key, and another instance can re-sign the hashes', () => {
  const seed = new Uint8Array(32).fill(7);
  const a = new StandIn(MODEL, seed);
  const b = new StandIn(MODEL, seed);
  assert.equal(a.publicKey, b.publicKey);
  const id = 'chatcmpl-standin-0123456789abcdef01234567';
  const hashes = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
  const r = b.signature(id, hashes);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.bytes.toString()).text, `${MODEL}:${hashes}`);
  assert.equal(b.signature(id, 'not-hashes').status, 404);
  assert.equal(b.signature('chatcmpl-real-id', hashes).status, 404, 'only stand-in ids');
});

test('signature lookups accept both id styles and forward them to NEAR AI with the key', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization });
    return new Response(JSON.stringify({ text: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const handler = createHandler({ model: MODEL, standIn, apiKey: KEY, fetch: fake });
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  for (const id of ['795d56c196f14dc8afa41b35c2a55c96', 'chatcmpl-0123456789abcdef']) {
    assert.equal((await fetch(`${b}/api/signature/${id}`)).status, 200, id);
  }
  assert.equal((await fetch(`${b}/api/signature/..%2Fadmin`)).status, 404);
  s.close();
  assert.ok(seen.every((x) => x.url.includes('/signature/') && x.url.endsWith('?signing_algo=ed25519') && x.auth === `Bearer ${KEY}`));
});
