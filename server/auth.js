import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

let cache = { mtimeMs: 0, users: new Map() };
let ephemeralSecret = null;

function sessionSecret() {
  if (config.sessionSecret) return config.sessionSecret;
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[weiwatch] SESSION_SECRET is not set. Using an ephemeral secret; sessions will be invalidated on restart.'
    );
  }
  return ephemeralSecret;
}

/**
 * Loads and validates credentials.json. The file is re-read whenever its
 * mtime changes, so you can edit users without restarting the server.
 */
export function loadCredentials({ force = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(config.credentialsFile);
  } catch {
    throw new Error(
      `Credentials file not found at ${config.credentialsFile}. Copy credentials.example.json to credentials.json and add your users.`
    );
  }

  if (!force && stat.mtimeMs === cache.mtimeMs && cache.users.size > 0) {
    return cache.users;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${config.credentialsFile}: ${err.message}`);
  }

  const list = Array.isArray(raw) ? raw : raw?.users;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('credentials.json must contain a non-empty "users" array.');
  }

  const users = new Map();
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`users[${index}] must be an object.`);
    }
    const username = String(entry.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      throw new Error(`users[${index}].username is invalid (2-32 chars: a-z 0-9 . _ -).`);
    }
    if (users.has(username)) {
      throw new Error(`Duplicate username "${username}" in credentials.json.`);
    }
    const password = typeof entry.password === 'string' ? entry.password : null;
    const passwordHash = typeof entry.passwordHash === 'string' ? entry.passwordHash : null;
    if (!password && !passwordHash) {
      throw new Error(`users[${index}] needs a "password" or "passwordHash" field.`);
    }
    users.set(username, {
      username,
      displayName: String(entry.displayName || entry.username).slice(0, 40),
      password,
      passwordHash,
    });
  }

  cache = { mtimeMs: stat.mtimeMs, users };
  return users;
}

export function findUser(username) {
  const users = loadCredentials();
  return users.get(String(username ?? '').trim().toLowerCase()) || null;
}

export function verifyPassword(user, password) {
  if (!user || typeof password !== 'string') return false;
  if (user.passwordHash) return verifyScrypt(password, user.passwordHash);
  if (user.password != null) {
    const provided = Buffer.from(password);
    const expected = Buffer.from(user.password);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }
  return false;
}

function verifyScrypt(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (!salt.length || !expected.length) return false;
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function signSession(user) {
  const payload = {
    u: user.username,
    n: user.displayName,
    exp: Date.now() + config.sessionTtlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.u || !payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function sessionCookie(token) {
  const parts = [
    `${config.cookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  const parts = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}
