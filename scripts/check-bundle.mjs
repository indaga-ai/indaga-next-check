// Fails if anything the browser downloads could carry the NEAR AI Cloud key. Run it after `npm run build`, with
// the key in the environment, the way a deploy has it:  NEARAI_API_KEY=... node scripts/check-bundle.mjs
// It looks for the key itself, its first 12 characters, the variable name, and anything shaped like an sk- key.
// It prints only file names and which rule matched, never a key.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../web/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(root);

const key = process.env.NEARAI_API_KEY || '';
const rules = [
  ['the variable name NEARAI_API_KEY', (t) => t.includes('NEARAI_API_KEY')],
  ['an sk- shaped key', (t) => /\bsk-[A-Za-z0-9_-]{20,}/.test(t)],
  ['an authorization header with a bearer token', (t) => /Bearer\s+[A-Za-z0-9._-]{20,}/.test(t)],
];
if (key) {
  rules.push(['the key itself', (t) => t.includes(key)]);
  if (key.length >= 12) rules.push(['the key\'s first 12 characters', (t) => t.includes(key.slice(0, 12))]);
}

let bad = 0;
for (const f of files) {
  const text = readFileSync(f, 'latin1');
  for (const [name, hit] of rules) {
    if (hit(text)) {
      bad += 1;
      console.error(`FOUND ${name} in ${f.slice(root.length)}`);
    }
  }
}
console.log(`${files.length} files checked against ${rules.length} rules${key ? ' (with the real key)' : ' (no key in the environment: name and shape rules only)'}: ${bad ? `${bad} problem(s)` : 'clean'}`);
process.exit(bad ? 1 : 0);
