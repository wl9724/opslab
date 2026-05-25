import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
export const DB_PATH = path.join(DATA_DIR, 'opslab.db');
export const SECRETS_PATH = path.join(DATA_DIR, 'secrets.bin');
export const TOKEN_PATH = path.join(DATA_DIR, 'access.token');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

export const PORT = Number(process.env.OPSLAB_PORT ?? 7821);
export const HOST = process.env.OPSLAB_HOST ?? '127.0.0.1';

function loadOrCreateToken(): string {
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export const ACCESS_TOKEN = loadOrCreateToken();

export const APP_URL = `http://${HOST}:${PORT}/?token=${ACCESS_TOKEN}`;
