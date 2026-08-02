// Verifies the two cryptographic paths that fail silently when wrong:
// Twilio request signatures and RFC 8291 web push encryption.
//
// Run with: npm test   (node --test, no framework needed)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createHmac, createDecipheriv, createPrivateKey, createPublicKey,
  diffieHellman, hkdfSync,
} from 'node:crypto';

import { encryptPayload } from '../src/notify.js';
import { verifyTwilioSignature } from '../src/twilio.js';
import { b64urlEncode, b64urlDecode, hashSecret, verifySecret, timingSafeEqual } from '../src/util.js';

/* ------------------------------------------------------------------ */
/* Twilio signatures                                                    */
/* ------------------------------------------------------------------ */
//
// Cross-checked against Node's crypto (a different HMAC implementation than
// the Worker's WebCrypto) over the canonical string Twilio documents:
// the full request URL followed by each POST param's key and value, sorted
// by key. `referenceSignature` below builds that independently.

const TWILIO_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const TWILIO_TOKEN = '12345';
const TWILIO_PARAMS = {
  Digits: '1234',
  To: '+18005551212',
  From: '+14158675310',
  Caller: '+14158675310',
  CallSid: 'CA1234567890ABCDE',
};

function referenceSignature(url, params, token) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return createHmac('sha1', token).update(payload).digest('base64');
}

test('verifyTwilioSignature matches an independent HMAC implementation', async () => {
  const expected = referenceSignature(TWILIO_URL, TWILIO_PARAMS, TWILIO_TOKEN);

  const req = new Request(TWILIO_URL, {
    method: 'POST',
    headers: { 'X-Twilio-Signature': expected },
  });

  const ok = await verifyTwilioSignature(
    req,
    { TWILIO_AUTH_TOKEN: TWILIO_TOKEN },
    new URLSearchParams(TWILIO_PARAMS),
  );
  assert.equal(ok, true);
});

test('verifyTwilioSignature rejects a tampered parameter', async () => {
  const expected = referenceSignature(TWILIO_URL, TWILIO_PARAMS, TWILIO_TOKEN);

  // Same signature, but the caller has been swapped in transit.
  const tampered = new URLSearchParams({ ...TWILIO_PARAMS, From: '+19995551234' });

  const req = new Request(TWILIO_URL, {
    method: 'POST',
    headers: { 'X-Twilio-Signature': expected },
  });

  assert.equal(
    await verifyTwilioSignature(req, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN }, tampered),
    false,
  );
});

test('verifyTwilioSignature rejects a signature from the wrong auth token', async () => {
  const req = new Request(TWILIO_URL, {
    method: 'POST',
    headers: {
      'X-Twilio-Signature': referenceSignature(TWILIO_URL, TWILIO_PARAMS, 'wrong-token'),
    },
  });

  assert.equal(
    await verifyTwilioSignature(
      req, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN }, new URLSearchParams(TWILIO_PARAMS),
    ),
    false,
  );
});

test('verifyTwilioSignature rejects a missing signature header', async () => {
  const req = new Request('https://example.com/twilio/voice', { method: 'POST' });
  assert.equal(
    await verifyTwilioSignature(req, { TWILIO_AUTH_TOKEN: '12345' }, new URLSearchParams()),
    false,
  );
});

/* ------------------------------------------------------------------ */
/* Web push — RFC 8291 aes128gcm                                        */
/* ------------------------------------------------------------------ */
//
// Validated by round trip: encrypt with the Worker's WebCrypto implementation,
// then decrypt with an independent one built on Node's crypto (hkdfSync,
// diffieHellman, createDecipheriv) written from the receiver's side of the
// spec. A browser push service performs exactly this decryption, so recovering
// the plaintext byte-for-byte is the property that matters in production.

/** Independent RFC 8291 receiver, implemented with Node primitives. */
function decryptPushRecord(record, uaPrivateJwk, uaPublicRaw, authSecret) {
  const salt = record.subarray(0, 16);
  const idlen = record[20];
  const asPublic = record.subarray(21, 21 + idlen);
  const ciphertext = record.subarray(21 + idlen);

  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: uaPrivateJwk, format: 'jwk' }),
    publicKey: createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(asPublic.subarray(1, 33)).toString('base64url'),
        y: Buffer.from(asPublic.subarray(33, 65)).toString('base64url'),
      },
      format: 'jwk',
    }),
  });

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), Buffer.from(uaPublicRaw), Buffer.from(asPublic),
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12),
  );

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);

  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  // Strip the 0x02 final-record delimiter.
  const end = padded.lastIndexOf(0x02);
  return padded.subarray(0, end).toString('utf8');
}

async function freshSubscriptionKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { p256dh: b64urlEncode(raw), raw, jwk };
}

test('encryptPayload output decrypts back to the exact plaintext', async () => {
  const plaintext = 'When I grow up, I want to be a watermelon';
  const { p256dh, raw, jwk } = await freshSubscriptionKeys();
  const authSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const record = await encryptPayload(plaintext, p256dh, authSecret);

  assert.equal(
    decryptPushRecord(record, jwk, raw, b64urlDecode(authSecret)),
    plaintext,
  );
});

test('encrypted record has the RFC 8291 header layout', async () => {
  const plaintext = 'When I grow up, I want to be a watermelon';
  const { p256dh } = await freshSubscriptionKeys();
  const authSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const record = await encryptPayload(plaintext, p256dh, authSecret);
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);

  assert.equal(view.getUint32(16), 4096, 'record size field');
  assert.equal(record[20], 65, 'uncompressed P-256 key length');
  // salt(16) + rs(4) + idlen(1) + key(65) + plaintext + delimiter(1) + tag(16)
  assert.equal(record.length, 21 + 65 + plaintext.length + 1 + 16);
});

test('a JSON push payload survives the round trip', async () => {
  const payload = JSON.stringify({
    title: 'Voicemail from (555) 123-4567',
    body: 'Hi, calling about the appointment — give me a ring back.',
    url: 'https://example.github.io/#/vm/abc123',
  });

  const { p256dh, raw, jwk } = await freshSubscriptionKeys();
  const authSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const record = await encryptPayload(payload, p256dh, authSecret);
  const decrypted = decryptPushRecord(record, jwk, raw, b64urlDecode(authSecret));

  assert.deepEqual(JSON.parse(decrypted), JSON.parse(payload));
});

test('encryptPayload produces a distinct record each call', async () => {
  const { p256dh } = await freshSubscriptionKeys();
  const authSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const a = await encryptPayload('hello', p256dh, authSecret);
  const b = await encryptPayload('hello', p256dh, authSecret);

  // Fresh salt + ephemeral key per message means no two records repeat.
  assert.notEqual(b64urlEncode(a), b64urlEncode(b));
});

/* ------------------------------------------------------------------ */
/* Recovery codes + constant-time compare                              */
/* ------------------------------------------------------------------ */

test('recovery code hashing round-trips and rejects wrong codes', async () => {
  const { hash, salt } = await hashSecret('ABCD-EFGH-JKLM');

  assert.equal(await verifySecret('ABCD-EFGH-JKLM', salt, hash), true);
  assert.equal(await verifySecret('ABCD-EFGH-JKLN', salt, hash), false);

  // Same code, different salt => different hash (no rainbow tables).
  const second = await hashSecret('ABCD-EFGH-JKLM');
  assert.notEqual(second.hash, hash);
});

test('PBKDF2 iterations stay within the Workers runtime limit', async () => {
  // Cloudflare Workers throws NotSupportedError above 100k iterations. Node
  // has no such cap, so this would pass locally and fail only in production —
  // assert the constant directly against the source.
  const src = await readFile(new URL('../src/util.js', import.meta.url), 'utf8');
  const match = /const PBKDF2_ITERS = ([\d_]+);/.exec(src);

  assert.ok(match, 'PBKDF2_ITERS constant not found');
  const iters = parseInt(match[1].replace(/_/g, ''), 10);

  assert.ok(iters <= 100_000, `PBKDF2_ITERS is ${iters}; Workers rejects anything above 100000`);
  assert.ok(iters >= 50_000, `PBKDF2_ITERS is ${iters}; too low to be worth doing`);
});

test('timingSafeEqual compares correctly', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(null, 'abc'), false);
});
