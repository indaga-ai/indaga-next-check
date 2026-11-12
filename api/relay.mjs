// The hosted relay: the same handler as `npm start`, as one Vercel function (adapted from DNA Confidential's
// api/relay.mjs, without payments). Static files are served by Vercel from web/ (see vercel.json); every /api/*
// path is rewritten here with the original path in `__path`.
// Environment: NEARAI_API_KEY (the attested model; without it, the stand-in answers and the page says so),
// HOSTED=1, and optionally STANDIN_SEED (hex), so every serverless instance's stand-in has the same key.
import { createHandler } from '../server/handler.mjs';
import { StandIn } from '../server/stand-in.mjs';
import { configFromEnv } from '../server/config.mjs';

const cfg = configFromEnv(process.env);
const seed = process.env.STANDIN_SEED ? Buffer.from(process.env.STANDIN_SEED, 'hex') : undefined;
const handler = createHandler({ ...cfg, standIn: new StandIn(cfg.model, seed) });

/** Restores the path the browser asked for from the rewrite's __path parameter. */
export function originalUrl(rewritten) {
  const url = new URL(rewritten, 'http://relay');
  const path = url.searchParams.get('__path');
  if (path === null) return rewritten;
  url.searchParams.delete('__path');
  const rest = url.searchParams.toString();
  return `/api/${path.replace(/^\/+/, '')}${rest ? `?${rest}` : ''}`;
}

export default function relay(req, res) {
  req.url = originalUrl(req.url);
  return handler(req, res);
}
