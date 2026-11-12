import { DEFAULT_MODEL } from '../src/ai/prompt.mjs';

// Settings from the environment. The API key is read here and passed only to the relay; it is never sent to the
// browser (the bundle is checked for it: scripts/check-bundle.mjs).
export function configFromEnv(env) {
  return {
    apiKey: env.NEARAI_API_KEY || '',
    base: env.NEARAI_BASE || 'https://cloud-api.near.ai/v1',
    model: env.MODEL || DEFAULT_MODEL,
    hosted: env.HOSTED === '1',
  };
}
