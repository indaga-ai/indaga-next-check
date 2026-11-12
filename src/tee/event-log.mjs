// Replays a dstack event log into RTMR values. For runtime (IMR 3) events the log carries the event name and
// payload but no digest; the digest is SHA-384(event_type as 4 little-endian bytes || ":" || name || ":" || payload),
// and each event extends RTMR = SHA-384(RTMR || digest), starting from 48 zero bytes. Earlier IMRs carry their
// digests. Checked against live NEAR AI Cloud quotes on 7 Nov 2026 (the replayed RTMR3 equals the quote's).
import { sha384 } from '@noble/hashes/sha2.js';
import { hexToBytes, concatBytes, utf8ToBytes, cleanHex } from '../util/bytes.mjs';

export function parseEventLog(log) {
  const events = typeof log === 'string' ? JSON.parse(log) : log;
  if (!Array.isArray(events)) throw new Error('event log is not a list');
  return events;
}

export function eventDigest(e) {
  if (e.digest) return hexToBytes(cleanHex(e.digest, 'event digest'));
  const type = new Uint8Array(4);
  new DataView(type.buffer).setUint32(0, Number(e.event_type) >>> 0, true);
  const payload = hexToBytes(cleanHex(e.event_payload || '', 'event payload'));
  return sha384(concatBytes(type, utf8ToBytes(':'), utf8ToBytes(e.event || ''), utf8ToBytes(':'), payload));
}

export function replayRtmr(log, imr) {
  let rtmr = new Uint8Array(48);
  for (const e of parseEventLog(log)) {
    if (Number(e.imr) !== imr) continue;
    rtmr = sha384(concatBytes(rtmr, eventDigest(e)));
  }
  return rtmr;
}

/** The payload of the first runtime event with this name, as hex (e.g. "compose-hash", "app-id", "os-image-hash"). */
export function runtimeEvent(log, name) {
  const e = parseEventLog(log).find((x) => Number(x.imr) === 3 && x.event === name);
  return e ? cleanHex(e.event_payload || '', name) : null;
}
