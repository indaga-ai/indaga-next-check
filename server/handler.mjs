// The relay, adapted from DNA Confidential's (private-dna-reading, server/handler.mjs) with payments removed. It
// serves the page and forwards four kinds of request to NEAR AI Cloud, adding the API key on the way. It never sees
// a case fact: the browser encrypts the facts to the model's attested key before sending.
//
// NOTHING IS KEPT. No request body, reply or log of either is stored anywhere: each handler forwards the bytes and
// returns. The only state is in memory: rate-limit counters (address and time, dropped after a day) and a
// ten-minute cache of Intel's public collateral. It also checks every brief request against the one fixed shape
// (model, roles, exact sizes, token cap) and rate-limits it, so the prototype is no free general-purpose endpoint.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { SYSTEM_PROMPT, MAX_USER_BYTES, MAX_TOKENS, TEMPERATURE, MODEL_SETTINGS, DEFAULT_MODEL } from '../src/ai/prompt.mjs';
import { E2EE_OVERHEAD, e2eeHeaders } from '../src/tee/e2ee.mjs';
import { PHALA_PCCS, NRAS_URL } from '../src/tee/hardware.mjs';
import { utf8ToBytes } from '../src/util/bytes.mjs';
import { RateLimiter } from './ratelimit.mjs';
import { HttpError } from './errors.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

// The page may talk only to this server, plus NVIDIA's attestation host for NVIDIA's public signing keys (so the
// GPU verdict our server relays can be checked against keys our server did not supply).
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://nras.attestation.nvidia.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

export { HttpError };

const HEX = /^[0-9a-f]+$/;
const hexLen = (bytes) => 2 * (E2EE_OVERHEAD + bytes);

/**
 * Checks a brief request against the fixed shape. Returns nothing; throws HttpError(400) on any difference.
 * The content is ciphertext, so the sizes are what can be checked: the system message must be exactly the size of
 * the fixed instructions, and the user message no larger than the case limit.
 */
export function checkBriefShape(body, { model }) {
  const extras = MODEL_SETTINGS[model] || {};
  const allowed = ['model', 'messages', 'max_tokens', 'temperature', 'stream', ...Object.keys(extras)];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_shape', 'body must be a JSON object');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new HttpError(400, 'bad_shape', `field not allowed: ${k}`);
  if (body.model !== model) throw new HttpError(400, 'bad_shape', `model must be ${model}`);
  for (const [k, v] of Object.entries(extras)) {
    if (JSON.stringify(body[k]) !== JSON.stringify(v)) throw new HttpError(400, 'bad_shape', `${k} must be ${JSON.stringify(v)}`);
  }
  if (body.stream !== undefined && body.stream !== false) throw new HttpError(400, 'bad_shape', 'stream must be false');
  if (body.max_tokens !== MAX_TOKENS) throw new HttpError(400, 'bad_shape', `max_tokens must be ${MAX_TOKENS}`);
  if (body.temperature !== TEMPERATURE) throw new HttpError(400, 'bad_shape', `temperature must be ${TEMPERATURE}`);
  const m = body.messages;
  if (!Array.isArray(m) || m.length !== 2) throw new HttpError(400, 'bad_shape', 'exactly two messages');
  const [sys, user] = m;
  for (const [msg, role] of [[sys, 'system'], [user, 'user']]) {
    if (!msg || typeof msg !== 'object' || Object.keys(msg).sort().join() !== 'content,role' || msg.role !== role) {
      throw new HttpError(400, 'bad_shape', `messages must be [system, user] with role and content only`);
    }
    if (typeof msg.content !== 'string' || !HEX.test(msg.content)) throw new HttpError(400, 'bad_shape', `${role} content must be encrypted (hex)`);
  }
  if (sys.content.length !== hexLen(utf8ToBytes(SYSTEM_PROMPT).length)) throw new HttpError(400, 'bad_shape', 'the system message is not the fixed instructions');
  if (user.content.length > hexLen(MAX_USER_BYTES) || user.content.length <= hexLen(0)) throw new HttpError(400, 'bad_shape', 'the user message is not a case within the size limit');
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
    'content-length': buf.length,
  });
  res.end(buf);
}

/** Forwards to NEAR AI Cloud and returns the exact response bytes (no re-encoding, so signatures still verify). */
async function upstream(cfg, path, { method = 'GET', body, headers = {}, auth = false } = {}) {
  const h = { accept: 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true', ...headers };
  if (auth) h.authorization = `Bearer ${cfg.apiKey}`;
  if (body) h['content-type'] = 'application/json';
  const r = await cfg.fetch(`${cfg.base}${path}`, { method, headers: h, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'application/json' };
}

export function createHandler(config) {
  const cfg = {
    base: 'https://cloud-api.near.ai/v1',
    model: DEFAULT_MODEL,
    signingAlgo: 'ed25519',
    staticRoot: null,
    hosted: false,
    timeoutMs: 120_000,
    fetch: globalThis.fetch,
    pccs: PHALA_PCCS,
    nras: NRAS_URL,
    ...config,
  };
  const collateralCache = new Map();
  const live = Boolean(cfg.apiKey);
  const briefs = new RateLimiter(cfg.limits?.briefs ?? { perHour: 12, perDay: 40, globalPerDay: 200 });
  const lookups = new RateLimiter(cfg.limits?.lookups ?? { perHour: 120, perDay: 600, globalPerDay: 20_000 });

  async function api(req, res, url) {
    const ip = clientIp(req);
    const route = url.pathname;

    if (route === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        model: cfg.model,
        signingAlgo: cfg.signingAlgo,
        inference: live ? 'near-ai-cloud' : 'stand-in',
        hosted: cfg.hosted,
        standInKey: live ? null : cfg.standIn?.publicKey ?? null,
        limits: { maxTokens: MAX_TOKENS },
      });
    }

    if (route === '/api/attestation' && req.method === 'GET') {
      lookups.take(ip);
      const nonce = url.searchParams.get('nonce') || '';
      if (!/^[0-9a-f]{64}$/.test(nonce)) throw new HttpError(400, 'bad_nonce', 'nonce must be 64 hex characters');
      const q = new URLSearchParams({ model: cfg.model, provider: 'near', signing_algo: cfg.signingAlgo, nonce, include_tls_fingerprint: 'false' });
      const r = await upstream(cfg, `/attestation/report?${q}`);
      return send(res, r.status, r.bytes, { 'content-type': r.type });
    }

    if (route === '/api/brief' && req.method === 'POST') {
      const raw = await readBody(req, 64 * 1024);
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'bad_json', 'body is not JSON');
      }
      checkBriefShape(body, { model: cfg.model });
      const clientKey = String(req.headers['x-client-pub-key'] || '');
      const modelKey = String(req.headers['x-model-pub-key'] || '');
      if (!/^[0-9a-f]{64}$/.test(clientKey) || !/^[0-9a-f]{64}$/.test(modelKey)) throw new HttpError(400, 'bad_keys', 'X-Client-Pub-Key and X-Model-Pub-Key must be 32-byte hex');
      briefs.take(ip);
      const e2ee = e2eeHeaders(clientKey, modelKey);
      if (!live) {
        const r = await cfg.standIn.chat(raw, e2ee);
        return send(res, r.status, r.bytes, { 'content-type': 'application/json' });
      }
      // The exact bytes the browser sent go upstream, so the request hash in the signature matches the browser's.
      const r = await upstream(cfg, '/chat/completions', { method: 'POST', body: raw, headers: e2ee, auth: true });
      return send(res, r.status, r.bytes, { 'content-type': r.type });
    }

    // Completion ids come as "chatcmpl-..." or, from some NEAR AI models, as 32 bare hex digits.
    const sig = /^\/api\/signature\/([A-Za-z0-9_-]{8,128})$/.exec(route);
    if (sig && req.method === 'GET') {
      lookups.take(ip);
      if (!live) {
        const r = cfg.standIn.signature(sig[1], url.searchParams.get('hashes'));
        return send(res, r.status, r.bytes, { 'content-type': 'application/json' });
      }
      const q = new URLSearchParams({ signing_algo: cfg.signingAlgo });
      const r = await upstream(cfg, `/signature/${sig[1]}?${q}`, { auth: true });
      return send(res, r.status, r.bytes, { 'content-type': r.type });
    }

    // Intel's collateral for the quote check, from a public PCCS. Intel signs it, so relaying it changes nothing
    // about trust; the browser cannot fetch it itself because Intel's service sends no CORS headers.
    const pccs = /^\/api\/pccs(\/(?:sgx|tdx)\/certification\/v4\/(?:pckcrl|tcb|qe\/identity|rootcacrl))$/.exec(route);
    if (pccs && req.method === 'GET') {
      lookups.take(ip);
      const allowed = new URLSearchParams();
      for (const k of ['ca', 'encoding', 'fmspc', 'update']) if (url.searchParams.has(k)) allowed.set(k, url.searchParams.get(k));
      const target = `${cfg.pccs}${pccs[1]}${allowed.size ? `?${allowed}` : ''}`;
      const hit = collateralCache.get(target);
      if (hit && Date.now() - hit.at < 10 * 60_000) return send(res, hit.status, hit.bytes, hit.headers);
      const r = await cfg.fetch(target, { signal: AbortSignal.timeout(20_000) });
      const headers = { 'content-type': r.headers.get('content-type') || 'application/octet-stream' };
      for (const h of ['sgx-pck-crl-issuer-chain', 'tcb-info-issuer-chain', 'sgx-tcb-info-issuer-chain', 'sgx-enclave-identity-issuer-chain']) {
        const v = r.headers.get(h);
        if (v) headers[h] = v;
      }
      const bytes = Buffer.from(await r.arrayBuffer());
      if (r.ok) collateralCache.set(target, { at: Date.now(), status: r.status, bytes, headers });
      if (collateralCache.size > 200) collateralCache.clear();
      return send(res, r.status, bytes, headers);
    }

    // NVIDIA's attestation service, which does not accept browser requests. The evidence is forwarded unchanged;
    // NVIDIA's signed answer is checked in the browser against NVIDIA's own keys.
    if (route === '/api/nras' && req.method === 'POST') {
      lookups.take(ip);
      const raw = await readBody(req, 1024 * 1024);
      const r = await cfg.fetch(cfg.nras, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: raw, signal: AbortSignal.timeout(30_000) });
      return send(res, r.status, Buffer.from(await r.arrayBuffer()), { 'content-type': r.headers.get('content-type') || 'application/json' });
    }

    throw new HttpError(404, 'not_found', 'no such route');
  }

  async function serveStatic(req, res, url) {
    if (!cfg.staticRoot) throw new HttpError(404, 'not_found', 'not found');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const root = resolve(cfg.staticRoot);
    const file = resolve(join(root, normalize(rel)));
    if (!file.startsWith(root + sep)) throw new HttpError(403, 'forbidden', 'forbidden');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'not_found', 'not found');
    }
    send(res, 200, data, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'method not allowed');
      return await serveStatic(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      const code = e instanceof HttpError ? e.code : 'upstream_error';
      // Never echo upstream bodies or headers here: they could carry account details.
      if (!(e instanceof HttpError)) console.error(`[relay] ${url.pathname}: ${e.name}: ${e.message}`);
      send(res, status, { error: { code, message: e instanceof HttpError ? e.message : 'the AI service could not be reached' } });
    }
  };
}
