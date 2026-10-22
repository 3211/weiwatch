import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

// Load .env for local development. Docker Compose injects the variables itself,
// and existing environment variables always win.
function loadDotEnv() {
  const file = path.resolve(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

export const config = {
  port: envInt('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  credentialsFile: path.resolve(ROOT, process.env.CREDENTIALS_FILE || 'credentials.json'),
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieName: 'ww_session',
  cookieSecure: envBool('COOKIE_SECURE', false),
  sessionTtlMs: envInt('SESSION_TTL_HOURS', 24 * 7) * 60 * 60 * 1000,
  trustProxy: envBool('TRUST_PROXY', false),
  proxyEnabled: envBool('PROXY_ENABLED', true),
  proxyTimeoutMs: envInt('PROXY_TIMEOUT_MS', 20000),
  proxyMaxHtmlBytes: envInt('PROXY_MAX_HTML_BYTES', 8 * 1024 * 1024),
  hostGraceMs: envInt('HOST_GRACE_SECONDS', 90) * 1000,
  roomIdleMs: envInt('ROOM_IDLE_MINUTES', 180) * 60 * 1000,
  maxChatHistory: 200,
  maxMessageLength: 2000,
};
