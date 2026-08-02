// Mint Voicemail — Cloudflare Worker entrypoint.
//
// Three surfaces:
//   /twilio/*  webhooks from Twilio, authenticated by request signature
//   /auth/*    passkey + failsafe sign-in
//   /api/*     the app's data API, authenticated by bearer session token

import { handleVoice, handleDone, handleRecording, verifyTwilioSignature } from './twilio.js';
import { handleAuth, purgeExpired } from './auth.js';
import { handleApi, purgeTrash } from './api.js';
import { json, err, corsHeaders, audit } from './util.js';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Preflight for the browser app.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, req) });
    }

    try {
      /* ---- Twilio webhooks ---- */
      if (path.startsWith('/twilio/')) {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

        const params = new URLSearchParams(await req.text());

        // Signature check gates every Twilio route. Without it, anyone who
        // guessed the URL could fabricate voicemails or burn transcription credit.
        if (!(await verifyTwilioSignature(req, env, params))) {
          await audit(env.DB, 'twilio_signature_rejected', { path }, req);
          return new Response('Forbidden', { status: 403 });
        }

        if (path === '/twilio/voice')     return handleVoice(req, env, params);
        if (path === '/twilio/done')      return handleDone();
        if (path === '/twilio/recording') return handleRecording(req, env, params, ctx);
        return new Response('Not found', { status: 404 });
      }

      /* ---- auth ---- */
      if (path.startsWith('/auth/')) return await handleAuth(req, env, path, ctx);

      /* ---- app API ---- */
      if (path.startsWith('/api/')) return await handleApi(req, env, path, ctx);

      /* ---- health ---- */
      if (path === '/' || path === '/health') {
        return json({
          ok: true,
          service: 'mint-voicemail',
          time: new Date().toISOString(),
        }, { env, req });
      }

      return err('Not found', 404, { env, req });
    } catch (e) {
      // Log the detail, return something generic — internals stay internal.
      ctx.waitUntil(audit(env.DB, 'unhandled_error', { path, error: String(e), stack: e?.stack?.slice(0, 500) }));
      return err('Something went wrong', 500, { env, req });
    }
  },

  // Nightly housekeeping: expire sessions/challenges, purge old trash.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([purgeExpired(env), purgeTrash(env)]));
  },
};
