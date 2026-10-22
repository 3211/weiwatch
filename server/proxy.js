import express from 'express';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { config } from './config.js';

export const proxyRouter = express.Router();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 5;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (value.startsWith('fe80')) return true;
    if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
    return false;
  }
  return true;
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Invalid host');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Private hosts are not allowed');
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Could not resolve host');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error('Private network addresses are not allowed');
  }
  return url;
}

async function fetchFollowing(url, signal, extraHeaders = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        ...extraHeaders,
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: current };
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/</g, '<');
}

function injectAgent(html, baseUrl) {
  let out = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');

  const headInjection = `<base href="${escapeAttribute(baseUrl)}"><script>window.__WEIWATCH_PROXY__=true;</script>`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (match) => `${match}${headInjection}`);
  } else {
    out = `${headInjection}${out}`;
  }

  const agentTag = '<script src="/sync-agent.js" data-weiwatch="1"></script>';
  if (/<\/body\s*>/i.test(out)) {
    out = out.replace(/<\/body\s*>/i, `${agentTag}</body>`);
  } else {
    out += agentTag;
  }
  return out;
}

proxyRouter.get('/proxy', async (req, res) => {
  if (!config.proxyEnabled) {
    return res.status(404).type('text/plain').send('Proxy is disabled on this server.');
  }

  const raw = req.query.url;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).type('text/plain').send('Missing ?url= parameter.');
  }

  let target;
  try {
    target = await assertPublicUrl(raw.trim());
  } catch (err) {
    return res.status(400).type('text/plain').send(`Blocked: ${err.message}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.proxyTimeoutMs);

  try {
    const range = typeof req.headers.range === 'string' ? req.headers.range : '';
    const { response, finalUrl } = await fetchFollowing(
      target,
      controller.signal,
      range ? { range } : {}
    );
    clearTimeout(timer);

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > config.proxyMaxHtmlBytes) {
        return res.status(502).type('text/plain').send('Page is too large to proxy.');
      }
      const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim() || 'utf-8';
      let html;
      try {
        html = new TextDecoder(charset).decode(buffer);
      } catch {
        html = buffer.toString('utf8');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(injectAgent(html, finalUrl.toString()));
    }

    res.status(response.status);
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    for (const header of ['content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!response.headers.get('content-encoding')) {
      const length = response.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
    }
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    clearTimeout(timer);
    if (res.headersSent) return res.end();
    const message = err?.name === 'AbortError' ? 'The site took too long to respond.' : err.message;
    return res.status(502).type('text/plain').send(`Proxy error: ${message}`);
  }
});
