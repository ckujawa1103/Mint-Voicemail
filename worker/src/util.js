// Shared helpers: encoding, crypto, rate limiting, HTTP responses.

export const now = () => Math.floor(Date.now() / 1000);

/* ---------- encoding ---------- */

export function b64urlEncode(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(bytes = 32) {
  return b64urlEncode(randomBytes(bytes));
}

/* ---------- hashing ---------- */

export async function sha256(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return b64urlEncode(await crypto.subtle.digest('SHA-256', data));
}

// Recovery codes are lower-entropy and human-typed, so stretch them.
const PBKDF2_ITERS = 210_000;

export async function hashSecret(secret, saltB64) {
  const salt = saltB64 ? b64urlDecode(saltB64) : randomBytes(16);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    key,
    256,
  );
  return { hash: b64urlEncode(bits), salt: b64urlEncode(salt) };
}

export async function verifySecret(secret, saltB64, expectedHash) {
  const { hash } = await hashSecret(secret, saltB64);
  return timingSafeEqual(hash, expectedHash);
}

// Constant-time string compare — avoids leaking match position via timing.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- rate limiting ---------- */

/**
 * Fixed-window limiter backed by D1. Returns true when the caller is over
 * budget. Auth endpoints lean on this hard: a leaked magic link or a guessed
 * recovery code should never be brute-forceable.
 */
export async function rateLimit(db, bucket, limit, windowSec) {
  const t = now();
  const row = await db.prepare('SELECT count, reset_at FROM rate_limits WHERE bucket = ?')
    .bind(bucket).first();

  if (!row || row.reset_at <= t) {
    await db.prepare(
      `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
    ).bind(bucket, t + windowSec).run();
    return false;
  }

  if (row.count >= limit) return true;

  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?')
    .bind(bucket).run();
  return false;
}

/* ---------- audit ---------- */

export async function audit(db, event, detail, req) {
  await db.prepare(
    'INSERT INTO audit_log (event, detail, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(
    event,
    typeof detail === 'string' ? detail : JSON.stringify(detail ?? null),
    req?.headers.get('CF-Connecting-IP') ?? null,
    req?.headers.get('User-Agent')?.slice(0, 300) ?? null,
    now(),
  ).run();
}

/* ---------- HTTP ---------- */

export function corsHeaders(env, req) {
  const origin = req?.headers.get('Origin');
  // Single-origin allowlist. Anything else gets no CORS grant at all.
  const allowed = origin && origin === env.APP_ORIGIN ? origin : env.APP_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(data, { status = 200, env, req, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(env ? corsHeaders(env, req) : {}),
      ...headers,
    },
  });
}

export function err(message, status = 400, opts = {}) {
  return json({ error: message }, { ...opts, status });
}

/* ---------- misc ---------- */

// +15551234567 -> (555) 123-4567
export function formatPhone(e164) {
  if (!e164) return 'Unknown caller';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
