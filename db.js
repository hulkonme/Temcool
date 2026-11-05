'use strict';

/**
 * Temcool storage layer.
 *
 * With `DATABASE_URL` set, sessions, rate-limit hits and an inbox event log
 * live in PostgreSQL so open inboxes survive restarts and work across
 * multiple instances. Without it, the same API is backed by in-memory maps,
 * which keeps local development dependency-free.
 *
 * Session rows hold the generated mail.tm password (needed to re-authenticate
 * after a restart) and a short-lived bearer token. Both belong to throwaway
 * mailboxes, never to a real account.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

let pool = null;
let mode = 'memory';

const memSessions = new Map();
const memHits = new Map();
let memCreated = 0;

class StoreError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreError';
    this.status = 503;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

function sslConfig() {
  const raw = String(process.env.PGSSL || '').trim().toLowerCase();
  if (!raw) return undefined; // honour sslmode= in the connection string
  if (raw === '0' || raw === 'false' || raw === 'disable') return false;
  if (raw === 'strict' || raw === 'verify') return true;
  // Hosted Postgres (Render, Railway, Supabase, …) usually presents a
  // certificate that Node does not have in its trust store.
  return { rejectUnauthorized: false };
}

function rowToSession(row) {
  return {
    sid: row.sid,
    accountId: row.account_id || '',
    address: row.address,
    password: row.password,
    token: row.token || '',
    tokenExp: Number(row.token_expires_at) || 0,
    createdAt: Number(row.created_at),
    inboxExpiresAt: Number(row.inbox_expires_at),
    expiresAt: Number(row.expires_at),
  };
}

/* ------------------------------------------------------------------ */
/* connection                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} [options.connectionString]
 * @param {number} [options.retries]
 * @param {number} [options.retryDelayMs]
 * @param {boolean} [options.allowMemoryFallback]
 * @param {Console} [options.logger]
 * @returns {Promise<{mode: 'postgres'|'memory'}>}
 */
async function init(options = {}) {
  const {
    connectionString = process.env.DATABASE_URL,
    retries = 10,
    retryDelayMs = 1500,
    allowMemoryFallback = process.env.ALLOW_MEMORY_FALLBACK === '1',
    logger = console,
  } = options;

  if (!connectionString) {
    mode = 'memory';
    logger.log('[temcool] DATABASE_URL is not set — using the in-memory store.');
    return { mode };
  }

  const { Pool } = require('pg');
  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 8_000,
    ...(sslConfig() === undefined ? {} : { ssl: sslConfig() }),
  });
  pool.on('error', (err) => {
    logger.error('[temcool] postgres idle client error:', err.message);
  });

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }

  if (lastError) {
    await pool.end().catch(() => {});
    pool = null;
    if (allowMemoryFallback) {
      mode = 'memory';
      logger.warn(
        `[temcool] could not reach PostgreSQL (${lastError.message}) — falling back to the in-memory store.`
      );
      return { mode };
    }
    throw new StoreError(
      `Could not connect to PostgreSQL: ${lastError.message}. Check DATABASE_URL, or set ALLOW_MEMORY_FALLBACK=1 to run without a database.`
    );
  }

  try {
    const schema = await fsp.readFile(SCHEMA_PATH, 'utf8');
    await pool.query(schema);
  } catch (err) {
    await pool.end().catch(() => {});
    pool = null;
    throw new StoreError(`Could not prepare the PostgreSQL schema: ${err.message}`, err);
  }

  mode = 'postgres';
  logger.log('[temcool] PostgreSQL connected — sessions are persistent.');
  return { mode };
}

function enabled() {
  return mode === 'postgres';
}

function currentMode() {
  return mode;
}

async function query(text, params = []) {
  if (!pool) throw new StoreError('The database connection is not ready.');
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[temcool] postgres query failed:', err.message);
    throw new StoreError('The database is unavailable. Please try again.', err);
  }
}

async function ping() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function close() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

async function getSession(sid) {
  if (!sid) return null;

  if (!enabled()) {
    const session = memSessions.get(sid);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      memSessions.delete(sid);
      return null;
    }
    return session;
  }

  const { rows } = await query('SELECT * FROM sessions WHERE sid = $1 LIMIT 1', [sid]);
  if (!rows.length) return null;
  const session = rowToSession(rows[0]);
  if (session.expiresAt < Date.now()) {
    await deleteSession(sid);
    return null;
  }
  return session;
}

async function saveSession(session, meta = {}) {
  if (!enabled()) {
    memSessions.set(session.sid, session);
    return;
  }
  await query(
    `INSERT INTO sessions
       (sid, account_id, address, password, token, token_expires_at,
        created_at, inbox_expires_at, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (sid) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       address = EXCLUDED.address,
       password = EXCLUDED.password,
       token = EXCLUDED.token,
       token_expires_at = EXCLUDED.token_expires_at,
       inbox_expires_at = EXCLUDED.inbox_expires_at,
       expires_at = EXCLUDED.expires_at,
       ip = COALESCE(EXCLUDED.ip, sessions.ip),
       user_agent = COALESCE(EXCLUDED.user_agent, sessions.user_agent),
       updated_at = now()`,
    [
      session.sid,
      session.accountId || '',
      session.address,
      session.password,
      session.token || '',
      session.tokenExp || 0,
      session.createdAt,
      session.inboxExpiresAt,
      session.expiresAt,
      meta.ip || null,
      meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
    ]
  );
}

async function updateSessionToken(sid, token, tokenExp) {
  if (!enabled()) return;
  await query('UPDATE sessions SET token = $2, token_expires_at = $3, updated_at = now() WHERE sid = $1', [
    sid,
    token,
    tokenExp,
  ]);
}

async function extendSession(sid, inboxExpiresAt, expiresAt) {
  if (!enabled()) return;
  await query(
    'UPDATE sessions SET inbox_expires_at = $2, expires_at = $3, updated_at = now() WHERE sid = $1',
    [sid, inboxExpiresAt, expiresAt]
  );
}

async function deleteSession(sid) {
  if (!enabled()) {
    memSessions.delete(sid);
    return;
  }
  await query('DELETE FROM sessions WHERE sid = $1', [sid]);
}

/* ------------------------------------------------------------------ */
/* rate limiting + stats                                               */
/* ------------------------------------------------------------------ */

async function rateLimited(ip, limit, windowMs) {
  if (!enabled()) {
    const now = Date.now();
    const hits = (memHits.get(ip) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) return true;
    hits.push(now);
    memHits.set(ip, hits);
    return false;
  }

  const result = await query(
    `INSERT INTO rate_limits (ip)
     SELECT $1::text
     WHERE (
       SELECT count(*) FROM rate_limits
       WHERE ip = $1::text
         AND created_at > now() - ($2::double precision * interval '1 millisecond')
     ) < $3
     RETURNING id`,
    [ip, windowMs, limit]
  );
  return result.rowCount === 0;
}

async function recordEvent(action, { address = '', ip = '' } = {}) {
  if (!enabled()) {
    if (action === 'created') memCreated += 1;
    return;
  }
  await query('INSERT INTO inbox_events (address, action, ip) VALUES ($1, $2, $3)', [
    address,
    action,
    ip || null,
  ]);
}

async function stats() {
  if (!enabled()) {
    return { enabled: false, created: memCreated, active: memSessions.size };
  }
  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM inbox_events WHERE action = 'created')::int AS created,
       (SELECT count(*) FROM sessions WHERE expires_at > $1)::int AS active`,
    [Date.now()]
  );
  return {
    enabled: true,
    created: rows[0]?.created || 0,
    active: rows[0]?.active || 0,
  };
}

/* ------------------------------------------------------------------ */
/* housekeeping                                                        */
/* ------------------------------------------------------------------ */

async function prune() {
  const now = Date.now();

  if (!enabled()) {
    for (const [sid, session] of memSessions) {
      if (session.expiresAt < now) memSessions.delete(sid);
    }
    const cutoff = now - 2 * 60 * 60 * 1000;
    for (const [ip, hits] of memHits) {
      const kept = hits.filter((t) => t > cutoff);
      if (kept.length) memHits.set(ip, kept);
      else memHits.delete(ip);
    }
    return;
  }

  await query('DELETE FROM sessions WHERE expires_at < $1', [now]);
  await query("DELETE FROM rate_limits WHERE created_at < now() - interval '2 hours'");
  await query("DELETE FROM inbox_events WHERE created_at < now() - interval '90 days'");
}

module.exports = {
  StoreError,
  init,
  close,
  ping,
  enabled,
  currentMode,
  getSession,
  saveSession,
  updateSessionToken,
  extendSession,
  deleteSession,
  rateLimited,
  recordEvent,
  stats,
  prune,
};
