// Small byte helpers shared by the browser and Node.
export { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';

/** Constant-length comparison of two byte arrays. */
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function readU16LE(b, off) {
  return b[off] | (b[off + 1] << 8);
}

export function readU32LE(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/** Lower-case hex without a 0x prefix; throws on anything that is not hex. */
export function cleanHex(s, label = 'value') {
  const h = String(s ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error(`${label} is not hex`);
  return h;
}
