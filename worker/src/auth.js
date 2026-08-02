// Authentication for exactly one person.
//
// Design goals, in order:
//   1. Nothing to forget      -> passkeys are the primary factor (no password).
//   2. Never locked out       -> two independent recovery paths.
//   3. Nobody else gets in    -> enrollment locks after the first passkey, every
//                                path is rate limited, and only OWNER_EMAIL counts.
//
// The three ways in:
//   - Passkey (Face ID / Touch ID / Windows Hello / security key)
//   - Magic link emailed to OWNER_EMAIL          [failsafe 1]
//   - One of ten single-use recovery codes       [failsafe 2]
//
// The failsafes grant a normal session AND the right to enroll a fresh passkey,
// which is what makes "I lost my phone" recoverable rather than fatal.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

import {
  now, randomToken, randomBytes, sha256, hashSecret, verifySecret,
  b64urlEncode, b64urlDecode, timingSafeEqual, rateLimit, audit, json, err,
} from './util.js';

import { sendMagicLink } from './notify.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days, sliding
const CHALLENGE_TTL = 5 * 60;
const MAGIC_TTL = 15 * 60;
const RECOVERY_CODE_COUNT = 10;

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

async function createSession(env, req, method) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, created_at, expires_at, last_seen_at, user_agent, ip, method)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    await sha256(token),
    t,
    t + SESSION_TTL,
    t,
    req.headers.get('User-Agent')?.slice(0, 300) ?? null,
    req.headers.get('CF-Connecting-IP') ?? null,
    method,
  ).run();
  return token;
}

/**
 * Resolve the bearer token on a request. Returns null when absent/expired.
 * Every non-auth API route goes through this.
 */
export async function requireSession(req, env) {
  const header = req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;

  const hash = await sha256(token);
  const row = await env.DB.prepare(
    'SELECT token_hash, expires_at, method FROM sessions WHERE token_hash = ?',
  ).bind(hash).first();

  if (!row || row.expires_at <= now()) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }

  // Slide the expiry, but only once a day to avoid a write per request.
  const t = now();
  if (t - (row.last_seen_at ?? 0) > 86400) {
    await env.DB.prepare(
      'UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?',
    ).bind(t + SESSION_TTL, t, hash).run();
  }
  return { tokenHash: hash, method: row.method };
}

/* ------------------------------------------------------------------ */
/* Enrollment state                                                    */
/* ------------------------------------------------------------------ */

async function credentialCount(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first();
  return row?.n ?? 0;
}

async function getState(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function setState(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value).run();
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

// Deliberately excludes I/O/0/1 — these get written down and typed back in.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRecoveryCode() {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

async function issueRecoveryCodes(env) {
  await env.DB.prepare('DELETE FROM recovery_codes').run();
  const codes = [];
  const t = now();
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = generateRecoveryCode();
    const { hash, salt } = await hashSecret(code);
    await env.DB.prepare(
      'INSERT INTO recovery_codes (code_hash, salt, created_at) VALUES (?, ?, ?)',
    ).bind(hash, salt, t).run();
    codes.push(code);
  }
  return codes; // shown exactly once, never retrievable again
}

/* ------------------------------------------------------------------ */
/* Route handler                                                       */
/* ------------------------------------------------------------------ */

export async function handleAuth(req, env, path, ctx) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const opts = { env, req };

  switch (path) {
    /* ---- status: what does the client need to show? ---- */
    case '/auth/status': {
      const session = await requireSession(req, env);
      return json({
        authenticated: !!session,
        enrolled: (await credentialCount(env)) > 0,
        setupComplete: (await getState(env, 'setup_complete')) === '1',
      }, opts);
    }

    /* ---- passkey registration ---- */
    case '/auth/register/options': {
      const session = await requireSession(req, env);
      const count = await credentialCount(env);

      // Two legitimate reasons to enroll a passkey:
      //   a) bootstrap  - no passkeys exist yet, prove it with the setup code
      //   b) add device - already signed in (including via a failsafe)
      if (!session) {
        if (count > 0) return err('Sign in first to add a passkey', 401, opts);
        if (!env.SETUP_CODE) return err('SETUP_CODE is not configured', 500, opts);
        if (await rateLimit(env.DB, `setup:${ip}`, 5, 3600)) {
          return err('Too many attempts. Try again later.', 429, opts);
        }
        if (!timingSafeEqual(String(body.setupCode || ''), env.SETUP_CODE)) {
          await audit(env.DB, 'setup_code_rejected', null, req);
          return err('Invalid setup code', 403, opts);
        }
      }

      const existing = await env.DB.prepare('SELECT id, transports FROM credentials').all();
      const options = await generateRegistrationOptions({
        rpName: env.RP_NAME || 'Mint Voicemail',
        rpID: env.RP_ID,
        userID: new TextEncoder().encode('owner'),
        userName: env.OWNER_EMAIL || 'owner',
        userDisplayName: 'Voicemail Owner',
        attestationType: 'none',
        excludeCredentials: (existing.results || []).map((c) => ({
          id: c.id,
          transports: c.transports ? JSON.parse(c.transports) : undefined,
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred', // biometric/PIN when the device offers it
        },
      });

      const challengeId = await storeChallenge(env, 'reg', options.challenge);
      return json({ options, challengeId }, opts);
    }

    case '/auth/register/verify': {
      const session = await requireSession(req, env);
      const count = await credentialCount(env);
      if (!session && count > 0) return err('Sign in first', 401, opts);

      const challenge = await consumeChallenge(env, body.challengeId, 'reg');
      if (!challenge) return err('Challenge expired — start over', 400, opts);

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: challenge,
          expectedOrigin: env.APP_ORIGIN,
          expectedRPID: env.RP_ID,
          requireUserVerification: false,
        });
      } catch (e) {
        await audit(env.DB, 'passkey_register_failed', String(e), req);
        return err('Passkey registration failed', 400, opts);
      }
      if (!verification.verified) return err('Passkey registration failed', 400, opts);

      const cred = verification.registrationInfo.credential;
      await env.DB.prepare(
        `INSERT INTO credentials (id, public_key, counter, transports, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        cred.id,
        b64urlEncode(cred.publicKey),
        cred.counter ?? 0,
        JSON.stringify(cred.transports ?? []),
        (body.label || 'Passkey').slice(0, 60),
        now(),
      ).run();

      await audit(env.DB, 'passkey_registered', { label: body.label }, req);

      // First passkey ever: hand over recovery codes and lock enrollment.
      let recoveryCodes = null;
      if (count === 0) {
        recoveryCodes = await issueRecoveryCodes(env);
        await setState(env, 'setup_complete', '1');
        await audit(env.DB, 'setup_completed', null, req);
      }

      const token = session ? null : await createSession(env, req, 'passkey');
      return json({ ok: true, token, recoveryCodes }, opts);
    }

    /* ---- passkey login ---- */
    case '/auth/login/options': {
      if (await rateLimit(env.DB, `login:${ip}`, 30, 900)) {
        return err('Too many attempts. Try again later.', 429, opts);
      }
      const creds = await env.DB.prepare('SELECT id, transports FROM credentials').all();
      if (!(creds.results || []).length) return err('No passkey enrolled yet', 404, opts);

      const options = await generateAuthenticationOptions({
        rpID: env.RP_ID,
        allowCredentials: creds.results.map((c) => ({
          id: c.id,
          transports: c.transports ? JSON.parse(c.transports) : undefined,
        })),
        userVerification: 'preferred',
      });

      const challengeId = await storeChallenge(env, 'auth', options.challenge);
      return json({ options, challengeId }, opts);
    }

    case '/auth/login/verify': {
      if (await rateLimit(env.DB, `loginv:${ip}`, 20, 900)) {
        return err('Too many attempts. Try again later.', 429, opts);
      }
      const challenge = await consumeChallenge(env, body.challengeId, 'auth');
      if (!challenge) return err('Challenge expired — start over', 400, opts);

      const cred = await env.DB.prepare(
        'SELECT id, public_key, counter, transports FROM credentials WHERE id = ?',
      ).bind(body.response?.id).first();
      if (!cred) return err('Unknown passkey', 404, opts);

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: challenge,
          expectedOrigin: env.APP_ORIGIN,
          expectedRPID: env.RP_ID,
          requireUserVerification: false,
          credential: {
            id: cred.id,
            publicKey: b64urlDecode(cred.public_key),
            counter: cred.counter,
            transports: cred.transports ? JSON.parse(cred.transports) : undefined,
          },
        });
      } catch (e) {
        await audit(env.DB, 'passkey_login_failed', String(e), req);
        return err('Sign-in failed', 401, opts);
      }
      if (!verification.verified) return err('Sign-in failed', 401, opts);

      // Rising signature counter detects a cloned authenticator.
      await env.DB.prepare(
        'UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?',
      ).bind(verification.authenticationInfo.newCounter, now(), cred.id).run();

      await audit(env.DB, 'login', { method: 'passkey' }, req);
      return json({ ok: true, token: await createSession(env, req, 'passkey') }, opts);
    }

    /* ---- failsafe 1: magic link to OWNER_EMAIL ---- */
    case '/auth/magic/request': {
      // Tight limit: this sends mail and is the widest attack surface.
      if (await rateLimit(env.DB, `magic:${ip}`, 3, 3600)) {
        return err('Too many requests. Try again in an hour.', 429, opts);
      }

      const email = String(body.email || '').trim().toLowerCase();
      const isOwner = env.OWNER_EMAIL && timingSafeEqual(email, env.OWNER_EMAIL.toLowerCase());

      if (isOwner) {
        const token = randomToken(32);
        await env.DB.prepare(
          'INSERT INTO challenges (id, kind, value, expires_at) VALUES (?, ?, ?, ?)',
        ).bind(randomToken(8), 'magic', await sha256(token), now() + MAGIC_TTL).run();

        // APP_BASE_URL, not APP_ORIGIN — the app lives under a subdirectory on
        // GitHub Pages, and a link to the bare origin would 404.
        const base = (env.APP_BASE_URL || env.APP_ORIGIN).replace(/\/+$/, '');
        const link = `${base}/#/magic?token=${encodeURIComponent(token)}`;
        ctx.waitUntil(sendMagicLink(env, link, req));
        await audit(env.DB, 'magic_link_sent', null, req);
      } else {
        await audit(env.DB, 'magic_link_wrong_email', { email }, req);
      }

      // Always the same answer: never reveal whether the address is the owner's.
      return json({ ok: true, message: 'If that address is authorized, a link is on its way.' }, opts);
    }

    case '/auth/magic/verify': {
      if (await rateLimit(env.DB, `magicv:${ip}`, 10, 3600)) {
        return err('Too many attempts. Try again later.', 429, opts);
      }
      const hash = await sha256(String(body.token || ''));
      const row = await env.DB.prepare(
        "SELECT id, expires_at, consumed_at FROM challenges WHERE kind = 'magic' AND value = ?",
      ).bind(hash).first();

      if (!row || row.consumed_at || row.expires_at <= now()) {
        await audit(env.DB, 'magic_link_invalid', null, req);
        return err('That link is invalid or has expired', 401, opts);
      }

      await env.DB.prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?')
        .bind(now(), row.id).run();
      await audit(env.DB, 'login', { method: 'magic_link' }, req);

      return json({ ok: true, token: await createSession(env, req, 'magic_link') }, opts);
    }

    /* ---- failsafe 2: single-use recovery codes ---- */
    case '/auth/recovery/use': {
      if (await rateLimit(env.DB, `recovery:${ip}`, 5, 3600)) {
        return err('Too many attempts. Try again in an hour.', 429, opts);
      }
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) return err('Enter a recovery code', 400, opts);

      const rows = await env.DB.prepare(
        'SELECT id, code_hash, salt FROM recovery_codes WHERE used_at IS NULL',
      ).all();

      let matched = null;
      for (const row of rows.results || []) {
        if (await verifySecret(code, row.salt, row.code_hash)) { matched = row; break; }
      }
      if (!matched) {
        await audit(env.DB, 'recovery_code_rejected', null, req);
        return err('Invalid or already-used recovery code', 401, opts);
      }

      await env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?')
        .bind(now(), matched.id).run();

      const remaining = (rows.results || []).length - 1;
      await audit(env.DB, 'login', { method: 'recovery_code', remaining }, req);

      return json({
        ok: true,
        token: await createSession(env, req, 'recovery_code'),
        remaining,
      }, opts);
    }

    case '/auth/recovery/regenerate': {
      if (!(await requireSession(req, env))) return err('Not signed in', 401, opts);
      await audit(env.DB, 'recovery_codes_regenerated', null, req);
      return json({ ok: true, recoveryCodes: await issueRecoveryCodes(env) }, opts);
    }

    case '/auth/recovery/status': {
      if (!(await requireSession(req, env))) return err('Not signed in', 401, opts);
      const row = await env.DB.prepare(
        'SELECT COUNT(*) AS remaining FROM recovery_codes WHERE used_at IS NULL',
      ).first();
      return json({ remaining: row?.remaining ?? 0, total: RECOVERY_CODE_COUNT }, opts);
    }

    /* ---- session + device management ---- */
    case '/auth/logout': {
      const session = await requireSession(req, env);
      if (session) {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
          .bind(session.tokenHash).run();
        await audit(env.DB, 'logout', null, req);
      }
      return json({ ok: true }, opts);
    }

    case '/auth/sessions': {
      const session = await requireSession(req, env);
      if (!session) return err('Not signed in', 401, opts);

      if (req.method === 'DELETE') {
        // Panic button: drop every session except this one.
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash != ?')
          .bind(session.tokenHash).run();
        await audit(env.DB, 'sessions_revoked', null, req);
        return json({ ok: true }, opts);
      }

      const rows = await env.DB.prepare(
        `SELECT token_hash, created_at, last_seen_at, user_agent, ip, method
           FROM sessions WHERE expires_at > ? ORDER BY created_at DESC`,
      ).bind(now()).all();

      return json({
        sessions: (rows.results || []).map((s) => ({
          id: s.token_hash.slice(0, 12),
          current: s.token_hash === session.tokenHash,
          createdAt: s.created_at,
          lastSeenAt: s.last_seen_at,
          userAgent: s.user_agent,
          ip: s.ip,
          method: s.method,
        })),
      }, opts);
    }

    case '/auth/credentials': {
      const session = await requireSession(req, env);
      if (!session) return err('Not signed in', 401, opts);

      if (req.method === 'DELETE') {
        const count = await credentialCount(env);
        // Never let the last passkey be removed from inside the app — that is
        // exactly how someone locks themselves out.
        if (count <= 1) {
          return err('That is your only passkey. Add another before removing this one.', 400, opts);
        }
        await env.DB.prepare('DELETE FROM credentials WHERE id = ?').bind(body.id).run();
        await audit(env.DB, 'passkey_removed', { id: body.id }, req);
        return json({ ok: true }, opts);
      }

      const rows = await env.DB.prepare(
        'SELECT id, label, created_at, last_used_at FROM credentials ORDER BY created_at',
      ).all();
      return json({ credentials: rows.results || [] }, opts);
    }

    case '/auth/audit': {
      if (!(await requireSession(req, env))) return err('Not signed in', 401, opts);
      const rows = await env.DB.prepare(
        'SELECT event, detail, ip, user_agent, created_at FROM audit_log ORDER BY created_at DESC LIMIT 100',
      ).all();
      return json({ events: rows.results || [] }, opts);
    }

    default:
      return err('Not found', 404, opts);
  }
}

/* ------------------------------------------------------------------ */
/* Challenge storage                                                   */
/* ------------------------------------------------------------------ */

async function storeChallenge(env, kind, value) {
  const id = randomToken(12);
  await env.DB.prepare(
    'INSERT INTO challenges (id, kind, value, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(id, kind, value, now() + CHALLENGE_TTL).run();
  return id;
}

async function consumeChallenge(env, id, kind) {
  if (!id) return null;
  const row = await env.DB.prepare(
    'SELECT value, expires_at, consumed_at FROM challenges WHERE id = ? AND kind = ?',
  ).bind(id, kind).first();

  if (!row || row.consumed_at || row.expires_at <= now()) return null;
  await env.DB.prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?').bind(now(), id).run();
  return row.value;
}

/** Housekeeping for the scheduled handler. */
export async function purgeExpired(env) {
  const t = now();
  await env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(t - 3600).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t).run();
  await env.DB.prepare('DELETE FROM audit_log WHERE created_at < ?').bind(t - 90 * 86400).run();
}
