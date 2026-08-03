// Notifications: Web Push (VAPID + RFC 8291) and Gmail via Google Apps Script.
//
// Email deliberately goes through Apps Script rather than an email vendor:
// the message is sent by your own Gmail account, so it threads properly, obeys
// your filters and labels, and no third party ever holds your voicemail text.

import { b64urlEncode, b64urlDecode, randomBytes, now, audit, formatPhone } from './util.js';

/**
 * Where the app actually lives, including any subdirectory.
 *
 * APP_ORIGIN is the bare origin because CORS and WebAuthn require that exact
 * form. Links we send a human need the full path — on GitHub Pages the app
 * sits under /<repo>/, so building links from the origin alone would drop
 * people on the domain root.
 */
function appBase(env) {
  return (env.APP_BASE_URL || env.APP_ORIGIN || '').replace(/\/+$/, '');
}

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
      url: `${appBase(env)}/#/vm/${vm.id}`,
    }),
    sendVoicemailEmail(env, vm),
    sendToAutomation(env, vm),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') await audit(env.DB, 'notify_failed', String(r.reason));
  }
}

/* ------------------------------------------------------------------ */
/* Home automation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Hand the voicemail to a webhook so a home automation stack can react to it —
 * announce it on a speaker, flash a lamp, page you differently when the caller
 * is on a short list.
 *
 * Deliberately fire-and-forget in spirit: unset either secret and this is a
 * no-op, so push and email are never held hostage to a self-hosted box being
 * up. The timeout matters more here than for the other legs — a home server
 * behind a residential connection can accept a TCP connection and then simply
 * stop, and without a bound this would pin the Worker invocation until the
 * platform killed it.
 */
async function sendToAutomation(env, vm) {
  if (!env.N8N_WEBHOOK_URL || !env.N8N_WEBHOOK_SECRET) return; // not configured

  const res = await fetch(env.N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Matches a Header Auth credential on the n8n webhook node. The
      // endpoint is on the public internet, so it needs to reject strangers.
      'X-Automation-Secret': env.N8N_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      id: vm.id,
      from: vm.from,
      fromLabel: vm.fromLabel,
      duration: vm.duration,
      transcript: vm.transcript,
      appUrl: `${appBase(env)}/#/vm/${vm.id}`,
      receivedAt: now(),
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`automation ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

/**
 * Resend — an alternative to Apps Script that needs only an API key, so it can
 * be configured without a browser OAuth consent flow.
 *
 * Apps Script is still the better choice when you want voicemail *notifications*
 * by email, since those carry transcripts and Apps Script keeps them inside your
 * own Gmail. For magic links alone nothing sensitive transits: the mail says
 * "here is a sign-in link", the token is single-use and expires in 15 minutes.
 */
async function sendViaResend(env, { subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Voicemail <onboarding@resend.dev>',
      to: [env.OWNER_EMAIL],
      subject,
      text,
      html,
    }),
  });

  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** True when some email transport is configured. */
function emailConfigured(env) {
  return !!env.RESEND_API_KEY || !!(env.GAS_WEBHOOK_URL && env.GAS_SHARED_SECRET);
}

async function sendVoicemailEmail(env, vm) {
  // Apps Script first when configured: it sends from your own Gmail, so
  // transcripts never reach a third party. Resend is the fallback.
  if (env.GAS_WEBHOOK_URL) return sendVoicemailEmailViaAppsScript(env, vm);
  if (!env.RESEND_API_KEY) return; // email not configured; push still fires

  const received = new Date(vm.receivedAt ? vm.receivedAt * 1000 : Date.now());
  const transcript = vm.transcript || 'Transcript not available yet — open the app to listen.';
  const appUrl = `${appBase(env)}/#/vm/${vm.id}`;

  await sendViaResend(env, {
    subject: `Voicemail from ${vm.fromLabel}`,
    text: [
      `${vm.fromLabel} left you a ${formatDuration(vm.duration)} voicemail.`,
      '',
      transcript,
      '',
      `Listen or manage: ${appUrl}`,
    ].join('\n'),
    html: voicemailHtml(vm.fromLabel, vm.duration, received, transcript, appUrl),
  });
}

function voicemailHtml(label, duration, received, transcript, appUrl) {
  const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ));

  return '' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px">' +
      '<div style="border-left:3px solid #16a34a;padding-left:16px;margin-bottom:20px">' +
        `<div style="font-size:18px;font-weight:600">${esc(label)}</div>` +
        `<div style="color:#666;font-size:13px">${formatDuration(duration)} &middot; ` +
          `${esc(received.toLocaleString('en-US'))}</div>` +
      '</div>' +
      '<div style="background:#f6f8f6;border-radius:10px;padding:16px;line-height:1.6;' +
        `font-size:15px;white-space:pre-wrap">${esc(transcript)}</div>` +
      `<a href="${esc(appUrl)}" style="display:inline-block;margin-top:20px;background:#16a34a;` +
        'color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">' +
        'Listen &amp; manage</a>' +
    '</div>';
}

function formatDuration(seconds) {
  const s = parseInt(seconds, 10) || 0;
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

async function sendVoicemailEmailViaAppsScript(env, vm) {
  await callAppsScript(env, {
    kind: 'voicemail',
    id: vm.id,
    from: vm.from,
    fromLabel: vm.fromLabel,
    duration: vm.duration,
    transcript: vm.transcript,
    appUrl: `${appBase(env)}/#/vm/${vm.id}`,
    receivedAt: now(),
  });
}

export async function sendMagicLink(env, link, req) {
  const ip = req?.headers.get('CF-Connecting-IP') || 'unknown';
  const userAgent = req?.headers.get('User-Agent') || 'unknown';

  if (!emailConfigured(env)) {
    // Loud in the audit log: this is a failsafe, and silently having no way to
    // deliver it is exactly the failure you find out about when locked out.
    await audit(env.DB, 'magic_link_no_transport', null, req);
    throw new Error('No email transport configured');
  }

  try {
    if (env.RESEND_API_KEY) {
      await sendViaResend(env, {
        subject: 'Your Voicemail sign-in link',
        text: [
          'Here is your sign-in link for Voicemail:',
          '',
          link,
          '',
          'It expires in 15 minutes and can be used once.',
          '',
          `Requested from IP ${ip}`,
          `Device: ${userAgent}`,
          '',
          "If you didn't request this, ignore this email. The link is useless",
          'without access to this inbox, and nobody else can trigger one.',
        ].join('\n'),
        html: magicLinkHtml(link, ip, userAgent),
      });
    } else {
      await callAppsScript(env, {
        kind: 'magic', link, ip, userAgent, expiresInMinutes: 15,
      });
    }
  } catch (e) {
    await audit(env.DB, 'magic_link_send_failed', String(e), req);
    throw e;
  }
}

function magicLinkHtml(link, ip, userAgent) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ));

  return '' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:480px">' +
      '<h2 style="margin:0 0 16px">Sign in to Voicemail</h2>' +
      '<p style="margin:0 0 24px;color:#444">Tap the button below. It expires in 15 minutes and works once.</p>' +
      `<a href="${esc(link)}" style="display:inline-block;background:#16a34a;color:#fff;` +
        'padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a>' +
      `<p style="margin:24px 0 0;font-size:12px;color:#888">Requested from ${esc(ip)}<br>` +
        `${esc(userAgent.slice(0, 120))}</p>` +
      '<p style="margin:16px 0 0;font-size:12px;color:#888">' +
        "If this wasn't you, you can ignore it safely.</p>" +
    '</div>';
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
