// Twilio webhooks: answering the forwarded call, then ingesting the recording.

import { now, randomToken, audit, formatPhone, clampInt } from './util.js';
import { transcribe } from './transcribe.js';
import { notifyNewVoicemail } from './notify.js';

/**
 * Validate X-Twilio-Signature (see Twilio "Validating Signatures").
 *
 * Twilio signs the full request URL with the POST params appended in
 * lexicographic key order, HMAC-SHA1 under the account auth token. Without
 * this check anyone who learns the webhook URL could inject fake voicemails.
 */
export async function verifyTwilioSignature(req, env, bodyParams) {
  const signature = req.headers.get('X-Twilio-Signature');
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;

  // Twilio signs the URL it was configured with. Behind Cloudflare the
  // inbound URL is already https, but normalize defensively.
  const url = new URL(req.url);
  url.protocol = 'https:';
  url.port = '';

  let payload = url.toString();
  for (const key of [...bodyParams.keys()].sort()) {
    payload += key + bodyParams.get(key);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Both are base64 of a fixed-length digest, so length is constant here.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function twiml(xml) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/**
 * POST /twilio/voice — a call Mint forwarded to us has arrived.
 *
 * A caller is on the line, so this must answer fast: write the row, return
 * TwiML, do nothing slow. Transcription happens later off the recording hook.
 */
export async function handleVoice(req, env, params) {
  const callSid = params.get('CallSid');
  const from = params.get('From') || 'unknown';

  if (callSid) {
    // ON CONFLICT: Twilio retries webhooks, and a duplicate must not create
    // a second voicemail row for the same call.
    await env.DB.prepare(
      `INSERT INTO voicemails
         (id, call_sid, from_number, from_name, from_city, from_state,
          to_number, created_at, transcript_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(call_sid) DO NOTHING`,
    ).bind(
      randomToken(12),
      callSid,
      from,
      params.get('CallerName') || null,
      params.get('FromCity') || null,
      params.get('FromState') || null,
      params.get('To') || null,
      now(),
    ).run();
  }

  const base = new URL(req.url).origin;
  const maxLength = clampInt(env.MAX_RECORDING_SEC, 30, 600, 180);

  // A recorded greeting wins over text-to-speech when one has been uploaded.
  // Driven by config rather than an R2 lookup so the call path stays fast —
  // a caller is on the line here.
  const greeting = env.GREETING_AUDIO
    ? `<Play>${base}/greeting.mp3</Play>`
    : `<Say voice="Polly.Joanna-Neural">${escapeXml(env.GREETING || 'Please leave a message after the tone.')}</Say>`;

  return twiml(
    `<Response>` +
      greeting +
      `<Record ` +
        `maxLength="${maxLength}" ` +
        `timeout="5" ` +
        `playBeep="true" ` +
        `trim="trim-silence" ` +
        `recordingStatusCallback="${base}/twilio/recording" ` +
        `recordingStatusCallbackEvent="completed" ` +
        `action="${base}/twilio/done" ` +
        `method="POST" />` +
      // Reached only if the caller hung up without recording.
      `<Say voice="Polly.Joanna-Neural">I didn't catch that. Goodbye.</Say>` +
      `<Hangup/>` +
    `</Response>`,
  );
}

/** POST /twilio/done — caller finished recording; say goodbye and hang up. */
export function handleDone() {
  return twiml(
    `<Response><Say voice="Polly.Joanna-Neural">Got it. Goodbye.</Say><Hangup/></Response>`,
  );
}

/**
 * POST /twilio/recording — the audio is ready.
 *
 * Returns immediately and does the slow work (download, store, transcribe,
 * notify) in waitUntil, so Twilio never sees a timeout.
 */
export async function handleRecording(req, env, params, ctx) {
  const callSid = params.get('CallSid');
  const recordingSid = params.get('RecordingSid');
  const recordingUrl = params.get('RecordingUrl');
  const duration = parseInt(params.get('RecordingDuration') || '0', 10);

  if (!callSid || !recordingUrl) return new Response('', { status: 204 });

  // Hang-ups and dial-tone blips aren't voicemails. Drop the placeholder row.
  if (duration < 2) {
    await env.DB.prepare('DELETE FROM voicemails WHERE call_sid = ? AND r2_key IS NULL')
      .bind(callSid).run();
    return new Response('', { status: 204 });
  }

  ctx.waitUntil(ingestRecording(env, { callSid, recordingSid, recordingUrl, duration }));
  return new Response('', { status: 204 });
}

async function ingestRecording(env, { callSid, recordingSid, recordingUrl, duration }) {
  try {
    const row = await env.DB.prepare(
      'SELECT id, from_number, from_name, r2_key FROM voicemails WHERE call_sid = ?',
    ).bind(callSid).first();

    if (!row) return;
    if (row.r2_key) return; // already ingested; Twilio retried

    const audio = await fetchRecording(env, recordingUrl);
    if (!audio) {
      await env.DB.prepare(
        "UPDATE voicemails SET transcript_status = 'failed' WHERE call_sid = ?",
      ).bind(callSid).run();
      return;
    }

    const key = `vm/${row.id}.mp3`;
    await env.AUDIO.put(key, audio, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });

    await env.DB.prepare(
      'UPDATE voicemails SET r2_key = ?, recording_sid = ?, duration_sec = ? WHERE call_sid = ?',
    ).bind(key, recordingSid, duration, callSid).run();

    // Transcribe. A failure here must not lose the voicemail — the audio is
    // already safe in R2 and the UI shows a retry affordance.
    let transcript = null;
    try {
      const result = await transcribe(env, audio);
      transcript = result.text;
      await env.DB.prepare(
        `UPDATE voicemails
            SET transcript = ?, transcript_status = 'done',
                transcript_provider = ?, transcript_confidence = ?
          WHERE call_sid = ?`,
      ).bind(result.text, result.provider, result.confidence ?? null, callSid).run();
    } catch (e) {
      await env.DB.prepare(
        "UPDATE voicemails SET transcript_status = 'failed' WHERE call_sid = ?",
      ).bind(callSid).run();
      await audit(env.DB, 'transcribe_failed', { callSid, error: String(e) });
    }

    // Delete the copy on Twilio's servers. We have it in R2, and leaving it
    // there costs money and widens where your voicemail lives.
    if (recordingSid) await deleteTwilioRecording(env, recordingSid);

    await notifyNewVoicemail(env, {
      id: row.id,
      from: row.from_number,
      fromLabel: row.from_name || formatPhone(row.from_number),
      duration,
      transcript,
    });
  } catch (e) {
    await audit(env.DB, 'ingest_failed', { callSid, error: String(e) });
  }
}

async function fetchRecording(env, recordingUrl) {
  const auth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  // The recording can lag the callback by a moment; retry with backoff.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${recordingUrl}.mp3`, { headers: { Authorization: auth } });
    if (res.ok) return await res.arrayBuffer();
    if (res.status !== 404) break;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return null;
}

async function deleteTwilioRecording(env, recordingSid) {
  try {
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.json`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        },
      },
    );
  } catch {
    // Non-fatal: worst case the recording lingers in Twilio storage.
  }
}
