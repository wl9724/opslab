import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { SECRETS_PATH } from './config.js';

const ALGO = 'aes-256-gcm';

function deriveKey(): Buffer {
  const seed = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.userInfo().username,
    process.env.OPSLAB_SECRET_SALT ?? 'opslab-default-salt-v1',
  ].join('|');
  return crypto.createHash('sha256').update(seed).digest();
}

const KEY = deriveKey();

type SecretMap = Record<string, string>;

function load(): SecretMap {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  try {
    const blob = fs.readFileSync(SECRETS_PATH);
    if (blob.length < 28) return {};
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (e) {
    console.error('[secrets] decryption failed, returning empty store', e);
    return {};
  }
}

function save(map: SecretMap): void {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(map), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(SECRETS_PATH, Buffer.concat([iv, tag, enc]), { mode: 0o600 });
}

export function setSecret(ref: string, value: string): void {
  const map = load();
  map[ref] = value;
  save(map);
}

export function getSecret(ref: string): string | undefined {
  return load()[ref];
}

export function deleteSecret(ref: string): void {
  const map = load();
  delete map[ref];
  save(map);
}

export function hasSecret(ref: string): boolean {
  return load()[ref] !== undefined;
}
