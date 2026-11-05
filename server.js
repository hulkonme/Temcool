'use strict';

/**
 * Temcool — free disposable email
 * Node server:
 *   - serves the static app from ./public
 *   - proxies mail.tm so the browser never hits CORS or stores credentials
 *   - keeps one inbox session per browser cookie
 *   - persists sessions, rate limits and events in PostgreSQL when
 *     DATABASE_URL is configured (falls back to memory otherwise)
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const store = require('./lib/db');

/** Minimal .env loader: existing environment variables always win. */
function loadEnvFile(file = path.join(__dirname, '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = String(process.env.MAIL_API_BASE || 'https://api.mail.tm').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // browser cookie / server session
const INBOX_TTL_MS = 60 * 60 * 1000; // visible "expires in" timer
const MAX_BODY = 32 * 1024;
const CREATE_LIMIT = 100; // inbox creations per IP per hour
const CREATE_WINDOW_MS = 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

let domainsCache = { at: 0, list: [] };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return (
    Boolean(req.socket.encrypted) ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.COOKIE_SECURE === '1'
  );
}

function sessionCookie(req, sid, maxAgeMs) {
  const parts = [
    `tc_sid=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

async function getSession(req) {
  const sid = parseCookies(req).tc_sid;
  if (!sid) return null;
  return store.getSession(sid);
}

async function requireSession(req) {
  const session = await getSession(req);
  if (!session) throw new HttpError(404, 'No inbox yet. Create a new address to get started.');
  return session;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(key) {
  return store.rateLimited(key, CREATE_LIMIT, CREATE_WINDOW_MS);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function upstreamMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 200);
  return data['hydra:description'] || data.detail || data.message || data.error || '';
}

/**
 * mail.tm answers with a plain array when asked for application/json and
 * with a Hydra collection for application/ld+json. Support both.
 */
function collection(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.['hydra:member'])) return data['hydra:member'];
  return [];
}

/* ------------------------------------------------------------------ */
/* mail.tm client                                                      */
/* ------------------------------------------------------------------ */

async function upstream(pathname, { method = 'GET', token, body, timeout = 15000 } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API_BASE + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the mail service. Check your connection and try again.');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data, headers: res.headers };
}

async function getDomains() {
  if (domainsCache.list.length && Date.now() - domainsCache.at < 30 * 60 * 1000) {
    return domainsCache.list;
  }
  const res = await upstream('/domains?page=1');
  if (res.status !== 200) {
    throw new HttpError(502, 'The mail service is unavailable right now. Please try again in a moment.');
  }
  const list = collection(res.data)
    .filter((d) => d && d.isActive !== false && d.isPrivate !== true && d.domain)
    .map((d) => d.domain);
  if (!list.length) {
    throw new HttpError(503, 'No temporary email domains are available right now.');
  }
  domainsCache = { at: Date.now(), list };
  return list;
}

async function getToken(session, force = false) {
  if (!force && session.token && session.tokenExp > Date.now()) return session.token;
  const res = await upstream('/token', {
    method: 'POST',
    body: { address: session.address, password: session.password },
  });
  if (res.status !== 200 || !res.data?.token) {
    throw new HttpError(502, 'This inbox is no longer available. Please create a new address.');
  }
  session.token = res.data.token;
  session.tokenExp = Date.now() + 50 * 60 * 1000;
  // Persist so another instance (or a restart) can reuse the token.
  await store.updateSessionToken(session.sid, session.token, session.tokenExp).catch((err) => {
    console.warn('[temcool] could not persist the access token:', err.message);
  });
  return session.token;
}

async function authFetch(session, pathname, init = {}) {
  let token = await getToken(session);
  let res = await upstream(pathname, { ...init, token });
  if (res.status === 401) {
    token = await getToken(session, true);
    res = await upstream(pathname, { ...init, token });
  }
  return res;
}

async function createAccount(local, domain) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const name = local || `tc${crypto.randomBytes(5).toString('hex')}`;
    const address = `${name}@${domain}`;
    const password = crypto.randomBytes(18).toString('base64url');
    const res = await upstream('/accounts', {
      method: 'POST',
      body: { address, password },
    });

    if (res.status === 200 || res.status === 201) {
      return { accountId: res.data?.id || '', address, password };
    }

    if (res.status === 429) {
      throw new HttpError(429, 'The mail service is busy. Please wait a few seconds and try again.');
    }

    const message = upstreamMessage(res.data);
    if (local) {
      if (/already (used|exists|registered)/i.test(message)) {
        throw new HttpError(409, 'That address is already taken. Try a different name.');
      }
      if (/invalid|not valid|must be/i.test(message)) {
        throw new HttpError(400, 'That address is not allowed. Use letters, numbers, dots, dashes or underscores.');
      }
      throw new HttpError(400, message || 'Could not create that address.');
    }
    // Random collision — try another name.
  }
  throw new HttpError(503, 'Could not find a free address. Please try again.');
}

async function deleteAccount(session) {
  if (!session?.accountId) return;
  try {
    const token = await getToken(session);
    await upstream(`/accounts/${session.accountId}`, { method: 'DELETE', token });
  } catch {
    /* best effort */
  }
}

/** Remove the mailbox upstream, then drop the session and log the event. */
async function retireSession(session, ip = '') {
  if (!session) return;
  await deleteAccount(session);
  await store.deleteSession(session.sid);
  await store.recordEvent('deleted', { address: session.address, ip });
}

/* ------------------------------------------------------------------ */
/* api routes                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  /* ---- domains --------------------------------------------------- */
  if (pathname === '/api/domains' && method === 'GET') {
    return sendJson(res, 200, { domains: await getDomains() });
  }

  /* ---- inbox: read ----------------------------------------------- */
  if (pathname === '/api/inbox' && method === 'GET') {
    const session = await getSession(req);
    let domains = [];
    try {
      domains = await getDomains();
    } catch {
      domains = domainsCache.list;
    }
    if (!session) {
      return sendJson(res, 200, { address: null, domains });
    }
    return sendJson(res, 200, {
      address: session.address,
      createdAt: session.createdAt,
      expiresAt: session.inboxExpiresAt,
      domains,
    });
  }

  /* ---- inbox: create --------------------------------------------- */
  if (pathname === '/api/inbox' && method === 'POST') {
    const ip = clientIp(req);
    const userAgent = String(req.headers['user-agent'] || '');

    if (await rateLimited(ip)) {
      throw new HttpError(429, 'Too many addresses from this network. Please try again later.');
    }

    const body = await readJson(req);
    const localRaw = typeof body.local === 'string' ? body.local.trim().toLowerCase() : '';
    const domainRaw = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';

    let local = '';
    if (localRaw) {
      if (localRaw.length > 32 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(localRaw)) {
        throw new HttpError(
          400,
          'Use 1–32 characters: letters, numbers, dots, dashes or underscores. Start and end with a letter or number.'
        );
      }
      local = localRaw;
    }

    const domains = await getDomains();
    const domain = domains.includes(domainRaw)
      ? domainRaw
      : domains[Math.floor(Math.random() * domains.length)];

    const requested = local ? `${local}@${domain}` : '';
    const old = await getSession(req);

    // Re-using the exact same address → extend instead of recreating.
    if (old && requested && requested === old.address) {
      old.inboxExpiresAt = Date.now() + INBOX_TTL_MS;
      old.expiresAt = Date.now() + SESSION_TTL_MS;
      await store.saveSession(old, { ip, userAgent });
      await store.recordEvent('extended', { address: old.address, ip });
      return sendJson(
        res,
        200,
        { address: old.address, createdAt: old.createdAt, expiresAt: old.inboxExpiresAt, domains },
        { 'Set-Cookie': sessionCookie(req, old.sid, SESSION_TTL_MS) }
      );
    }

    const account = await createAccount(local, domain);

    // Everything worked — retire the previous inbox.
    if (old) await retireSession(old, ip);

    const sid = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const session = {
      sid,
      accountId: account.accountId,
      address: account.address,
      password: account.password,
      token: '',
      tokenExp: 0,
      createdAt: now,
      inboxExpiresAt: now + INBOX_TTL_MS,
      expiresAt: now + SESSION_TTL_MS,
    };

    // Store the session before warming the token: getToken persists the
    // token with an UPDATE, and sessions are upserted by sid.
    await store.saveSession(session, { ip, userAgent });
    await store.recordEvent('created', { address: session.address, ip });

    // Warm up the token so the first inbox poll is instant.
    try {
      await getToken(session);
    } catch {
      /* the frontend retries */
    }

    return sendJson(
      res,
      201,
      { address: session.address, createdAt: session.createdAt, expiresAt: session.inboxExpiresAt, domains },
      { 'Set-Cookie': sessionCookie(req, sid, SESSION_TTL_MS) }
    );
  }

  /* ---- inbox: extend --------------------------------------------- */
  if (pathname === '/api/inbox/extend' && method === 'POST') {
    const session = await requireSession(req);
    session.inboxExpiresAt = Date.now() + INBOX_TTL_MS;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    await store.saveSession(session);
    await store.recordEvent('extended', { address: session.address, ip: clientIp(req) });
    return sendJson(
      res,
      200,
      { address: session.address, expiresAt: session.inboxExpiresAt },
      { 'Set-Cookie': sessionCookie(req, session.sid, SESSION_TTL_MS) }
    );
  }

  /* ---- inbox: delete --------------------------------------------- */
  if (pathname === '/api/inbox' && method === 'DELETE') {
    const session = await getSession(req);
    if (session) await retireSession(session, clientIp(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  /* ---- public stats ---------------------------------------------- */
  if (pathname === '/api/stats' && method === 'GET') {
    return sendJson(res, 200, await store.stats());
  }

  /* ---- messages: list -------------------------------------------- */
  if (pathname === '/api/messages' && method === 'GET') {
    const session = await requireSession(req);
    const result = await authFetch(session, '/messages?page=1');
    if (result.status === 401) {
      throw new HttpError(401, 'This inbox session expired. Create a new address.');
    }
    if (result.status !== 200) {
      throw new HttpError(502, 'Could not load messages. Please try again.');
    }
    const rows = collection(result.data);
    const messages = rows
      .map((m) => ({
        id: m.id,
        from: m.from || { address: '', name: '' },
        to: m.to || [],
        subject: m.subject || '',
        intro: m.intro || '',
        seen: Boolean(m.seen),
        hasAttachments: Boolean(m.hasAttachments),
        size: m.size || 0,
        createdAt: m.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(res, 200, { messages, count: messages.length });
  }

  /* ---- messages: detail / delete --------------------------------- */
  const messageMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (messageMatch) {
    const session = await requireSession(req);
    const id = decodeURIComponent(messageMatch[1]);

    if (method === 'GET') {
      const result = await authFetch(session, `/messages/${encodeURIComponent(id)}`);
      if (result.status === 404) throw new HttpError(404, 'That message no longer exists.');
      if (result.status !== 200) throw new HttpError(502, 'Could not open that message.');
      const m = result.data || {};
      if (!m.seen) {
        // Mark as read in the background.
        authFetch(session, `/messages/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { seen: true },
        }).catch(() => {});
      }
      const html = Array.isArray(m.html) ? m.html.join('\n') : m.html || '';
      return sendJson(res, 200, {
        id: m.id || id,
        from: m.from || { address: '', name: '' },
        to: m.to || [],
        subject: m.subject || '',
        intro: m.intro || '',
        text: m.text || '',
        html,
        seen: true,
        hasAttachments: Boolean(m.hasAttachments),
        createdAt: m.createdAt,
        attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => ({
          id: a.id,
          filename: a.filename || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || 0,
        })),
      });
    }

    if (method === 'DELETE') {
      const result = await authFetch(session, `/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (result.status !== 204 && result.status !== 200) {
        throw new HttpError(502, 'Could not delete that message.');
      }
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---- attachments ----------------------------------------------- */
  const attachMatch = pathname.match(/^\/api\/messages\/([^/]+)\/attachments\/([^/]+)$/);
  if (attachMatch && method === 'GET') {
    const session = await requireSession(req);
    const id = decodeURIComponent(attachMatch[1]);
    const attachmentId = decodeURIComponent(attachMatch[2]);

    const detail = await authFetch(session, `/messages/${encodeURIComponent(id)}`);
    if (detail.status !== 200) throw new HttpError(404, 'That attachment no longer exists.');
    const attachment = (detail.data?.attachments || []).find((a) => a.id === attachmentId);
    if (!attachment) throw new HttpError(404, 'That attachment no longer exists.');

    const token = await getToken(session);
    let file;
    try {
      file = await fetch(
        `${API_BASE}/messages/${encodeURIComponent(id)}/attachment/${encodeURIComponent(attachmentId)}`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) }
      );
    } catch {
      throw new HttpError(502, 'Could not download that attachment.');
    }
    if (!file.ok) throw new HttpError(502, 'Could not download that attachment.');

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = String(attachment.filename || 'attachment')
      .replace(/[\r\n"]/g, '')
      .slice(0, 180);
    res.writeHead(200, {
      'Content-Type': attachment.contentType || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
    });
    return res.end(buffer);
  }

  throw new HttpError(404, 'Not found.');
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed.');
  }

  let pathnameDecoded;
  try {
    pathnameDecoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad request.');
  }

  const rel = pathnameDecoded === '/' ? 'index.html' : pathnameDecoded.replace(/^\/+/, '');
  const root = path.resolve(PUBLIC_DIR);
  let filePath = path.resolve(root, rel);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    throw new HttpError(403, 'Forbidden.');
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    // Unknown path → single page app fallback.
    filePath = path.join(root, 'index.html');
    stat = await fsp.stat(filePath);
  }

  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = await fsp.stat(filePath);
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(await fsp.readFile(filePath));
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    const storage = store.currentMode();
    if (store.enabled() && !(await store.ping())) {
      return sendJson(res, 503, {
        ok: false,
        storage,
        error: 'database unavailable',
        uptime: Math.round(process.uptime()),
      });
    }
    return sendJson(res, 200, { ok: true, storage, uptime: Math.round(process.uptime()) });
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const known = err instanceof HttpError || Number.isInteger(err?.status);
    if (!known) console.error('[temcool]', err);
    sendJson(res, known ? err.status : 500, {
      error: known ? err.message : 'Something went wrong on our side. Please try again.',
    });
  });
});

async function main() {
  await store.init();
  server.listen(PORT, HOST, () => {
    console.log(`[temcool] running at http://localhost:${PORT} (storage: ${store.currentMode()})`);
  });
}

/* Housekeeping: expired sessions, old rate-limit hits and events. */
setInterval(() => {
  store.prune().catch((err) => console.error('[temcool] housekeeping failed:', err.message));
}, 5 * 60 * 1000).unref();

process.on('SIGTERM', () => {
  server.close(() => {
    store.close().finally(() => process.exit(0));
  });
});
process.on('SIGINT', () => {
  server.close(() => {
    store.close().finally(() => process.exit(0));
  });
});

main().catch((err) => {
  console.error('[temcool] startup failed:', err.message);
  process.exit(1);
});
