// Notifications: Web Push (VAPID + RFC 8291) and Gmail via Google Apps Script.
//
// Email deliberately goes through Apps Script rather than an email vendor:
// the message is sent by your own Gmail account, so it threads properly, obeys
// your filters and labels, and no third party ever holds your voicemail text.

import { b64urlEncode, b64urlDecode, randomBytes, now, audit, formatPhone } from './util.js';

/* ------------------------------------------------------------------ */
/* Fan-out                                                             */
/* ------------------------------------------------------------------ */

export async function notifyNewVoicemail(env, vm) {
  const results = await Promise.allSettled([
    sendPushToAll(env, {
      title: `Voicemail from ${vm.fromLabel}`,
      body: vm.transcript
        ? vm.transcript.slice(0, 180)
        : `${vm.duration}s message — transcript pending`,
      tag: `vm-${vm.id}`,
      url: `${env.APP_ORIGIN}/#/vm/${vm.id}`,
    }),
    sendVoicemailEmail(env, vm),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') await audit(env.DB, 'notify_failed', String(r.reason));
  }
}

/* ------------------------------------------------------------------ */
/* Gmail, via Apps Script                                              */
/* ------------------------------------------------------------------ */

async function callAppsScript(env, payload) {
  if (!env.GAS_WEBHOOK_URL || !env.GAS_SHARED_SECRET) return; // email not configured

  const res = await fetch(env.GAS_WEBHOOK_URL, {
    method: 'POST',
    // text/plain keeps this a CORS "simple request" and avoids the preflight
    // that Apps Script cannot answer. Apps Script parses the body itself.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: env.GAS_SHARED_SECRET }),
    redirect: 'follow', // Apps Script 302s to googleusercontent.com
  });

  if (!res.ok) throw new Error(`apps script ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendVoicemailEmail(env, vm) {
  await callAppsScript(env, {
    kind: 'voicemail',
    id: vm.id,
    from: vm.from,
    fromLabel: vm.fromLabel,
    duration: vm.duration,
    transcript: vm.transcript,
    appUrl: `${env.APP_ORIGIN}/#/vm/${vm.id}`,
    receivedAt: now(),
  });
}

export async function sendMagicLink(env, link, req) {
  try {
    await callAppsScript(env, {
      kind: 'magic',
      link,
      ip: req?.headers.get('CF-Connecting-IP') || 'unknown',
      userAgent: req?.headers.get('User-Agent') || 'unknown',
      expiresInMinutes: 15,
    });
  } catch (e) {
    await audit(env.DB, 'magic_link_send_failed', String(e), req);
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Web Push                                                            */
/* ------------------------------------------------------------------ */

async function sendPushToAll(env, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  const subs = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions',
  ).all();

  await Promise.allSettled(
    (subs.results || []).map(async (sub) => {
      try {
        const res = await sendPush(env, sub, JSON.stringify(payload));
        // 404/410 mean the browser dropped the subscription for good.
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
            .bind(sub.endpoint).run();
        }
      } catch (e) {
        await audit(env.DB, 'push_failed', String(e));
      }
    }),
  );
}

async function sendPush(env, sub, payloadText) {
  const endpoint = new URL(sub.endpoint);
  const body = await encryptPayload(payloadText, sub.p256dh, sub.auth);
  const jwt = await createVapidJwt(env, endpoint.origin);

  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
}

/** Signed JWT proving to the push service which application server we are. */
async function createVapidJwt(env, audience) {
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now() + 12 * 3600,
    sub: `mailto:${env.OWNER_EMAIL || 'owner@example.com'}`,
  })));

  const signingInput = `${header}.${claims}`;
  const key = await importVapidPrivateKey(env);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  // WebCrypto already returns the raw r||s form JWS wants.
  return `${signingInput}.${b64urlEncode(sig)}`;
}

async function importVapidPrivateKey(env) {
  const pub = b64urlDecode(env.VAPID_PUBLIC_KEY); // 0x04 || x(32) || y(32)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * RFC 8291 aes128gcm payload encryption.
 *
 * Output record: salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext
 *
 * `overrides` exists so the RFC 8291 Appendix A test vector can pin the
 * ephemeral key and salt; production always generates both fresh.
 */
export async function encryptPayload(plaintext, p256dhB64, authB64, overrides = {}) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);

  // Ephemeral application-server keypair, fresh per message.
  const asKeys = overrides.asKeys || await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256),
  );

  const salt = overrides.salt || randomBytes(16);

  // IKM is derived from the shared secret keyed by the subscription's auth secret.
  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic,
  );
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // 0x02 is the final-record padding delimiter.
  const padded = concat(new TextEncoder().encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = asPublic.length; // 65

  return concat(header, asPublic, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);                       // extract
  const okm = await hmac(prk, concat(info, new Uint8Array([1]))); // expand (one block)
  return okm.slice(0, length);
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** Digest sent to the client so it can label the notification source. */
export function pushPublicKey(env) {
  return env.VAPID_PUBLIC_KEY || null;
}

export { formatPhone };
