// Reads the fields of an Intel TDX quote (version 4). The TD report body starts at byte 48; the offsets
// below were checked against live NEAR AI Cloud quotes on 7 Nov 2026 (MRTD, RTMR0-3 and MRCONFIGID equal
// the values the service reports beside the quote).
import { hexToBytes, readU16LE, readU32LE, cleanHex } from '../util/bytes.mjs';

const FIELDS = {
  teeTcbSvn: [48, 16],
  mrSeam: [64, 48],
  mrSignerSeam: [112, 48],
  seamAttributes: [160, 8],
  tdAttributes: [168, 8],
  xfam: [176, 8],
  mrTd: [184, 48],
  mrConfigId: [232, 48],
  mrOwner: [280, 48],
  mrOwnerConfig: [328, 48],
  rtmr0: [376, 48],
  rtmr1: [424, 48],
  rtmr2: [472, 48],
  rtmr3: [520, 48],
  reportData: [568, 64],
};

export function parseTdxQuote(quote) {
  const q = typeof quote === 'string' ? hexToBytes(cleanHex(quote, 'quote')) : quote;
  if (q.length < 636) throw new Error(`quote too short (${q.length} bytes)`);
  const version = readU16LE(q, 0);
  const attestationKeyType = readU16LE(q, 2);
  const teeType = readU32LE(q, 4);
  if (version !== 4 || teeType !== 0x81) {
    throw new Error(`not a TDX version 4 quote (version ${version}, TEE type 0x${teeType.toString(16)})`);
  }
  const out = { version, attestationKeyType, teeType, bytes: q };
  for (const [name, [off, len]] of Object.entries(FIELDS)) out[name] = q.subarray(off, off + len);
  out.signatureDataLength = readU32LE(q, 632);
  // TD attribute bit 0 is DEBUG: a debug TD lets the host read its memory, so it must be off.
  out.debug = (out.tdAttributes[0] & 1) === 1;
  return out;
}
