// The app_compose document says what the TEE runs (its docker-compose file and settings). Its SHA-256 is bound
// to the quote twice: MRCONFIGID = 0x01 || SHA-256(app_compose) || zero padding, and the "compose-hash" runtime
// event that RTMR3 covers.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '../util/bytes.mjs';

export function composeHash(appCompose) {
  return bytesToHex(sha256(utf8ToBytes(appCompose)));
}

export function expectedMrConfigId(appCompose) {
  return `01${composeHash(appCompose)}`.padEnd(96, '0');
}

/** The container images named in the compose file, with digests where pinned. */
export function composeImages(appCompose) {
  let file = '';
  try {
    file = JSON.parse(appCompose).docker_compose_file || '';
  } catch {
    return [];
  }
  const images = [];
  let service = null;
  for (const line of file.split('\n')) {
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (svc) service = svc[1];
    const img = /^\s+image:\s*["']?([^\s"']+)["']?/.exec(line);
    if (img) images.push({ service, image: img[1], pinned: /@sha256:[0-9a-f]{64}$/.test(img[1]) });
  }
  return images;
}
