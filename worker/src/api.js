// Voicemail CRUD, audio streaming, and push-subscription management.

import {
  now, json, err, sha256, b64urlEncode, timingSafeEqual,
  audit, formatPhone, clampInt, corsHeaders,
} from './util.js';
import { requireSession } from './auth.js';
import { transcribe } from './transcribe.js';

function shape(row) {
  return {
    id: row.id,
    from: row.from_number,
    fromLabel: row.from_name || formatPhone(row.from_number),
    fromCity: row.from_city,
    fromState: row.from_state,
    duration: row.duration_sec,
    transcript: row.transcript,
    transcriptStatus: row.transcript_status,
    transcriptProvider: row.transcript_provider,
    confidence: row.transcript_confidence,
    isRead: !!row.is_read,
    isSaved: !!row.is_saved,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    hasAudio: !!row.r2_key,
  };
}

export async function handleApi(req, env, path, ctx) {
  const opts = { env, req };
  const url = new URL(req.url);

  // Audio is fetched by the browser's <audio> element, which cannot attach an
  // Authorization header. It authenticates with a short-lived signed token
  // instead — see signAudioToken below.
  const audioMatch = /^\/api\/voicemails\/([\w-]+)\/audio$/.exec(path);
  if (audioMatch && req.method === 'GET') {
    return streamAudio(req, env, audioMatch[1], url.searchParams.get('t'));
  }

  const session = await requireSession(req, env);
  if (!session) return err('Not signed in', 401, opts);

  /* ---- collection ---- */
  if (path === '/api/voicemails' && req.method === 'GET') {
    const filter = url.searchParams.get('filter') || 'inbox';
    const q = (url.searchParams.get('q') || '').trim();
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);

    let where;
    if (filter === 'trash') where = 'deleted_at IS NOT NULL';
    else if (filter === 'saved') where = 'deleted_at IS NULL AND is_saved = 1';
    else if (filter === 'unread') where = 'deleted_at IS NULL AND is_read = 0';
    else where = 'deleted_at IS NULL';

    const binds = [];
    if (q) {
      where += ' AND (transcript LIKE ? OR from_number LIKE ? OR from_name LIKE ?)';
      binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const rows = await env.DB.prepare(
      `SELECT * FROM voicemails WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
    ).bind(...binds, limit).all();

    const items = await Promise.all((rows.results || []).map(async (r) => ({
      ...shape(r),
      audioUrl: r.r2_key
        ? `${url.origin}/api/voicemails/${r.id}/audio?t=${await signAudioToken(env, r.id)}`
        : null,
    })));

    return json({ voicemails: items }, opts);
  }

  // Apply one action to a set of voicemails. Declared before the single-item
  // routes below, which would otherwise read "bulk" as a voicemail id.
  //
  // One request rather than one per message: a loop in the browser is slow
  // over a phone connection and can half-finish, leaving the list showing a
  // state the database never had.
  if (path === '/api/voicemails/bulk' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    // Ids come from our own list responses, but they still land in SQL, so
    // they're shape-checked and de-duplicated before going anywhere near it.
    const ids = [...new Set(
      (Array.isArray(body.ids) ? body.ids : [])
        .filter((id) => typeof id === 'string' && /^[\w-]+$/.test(id)),
    )];

    if (!ids.length) return err('No voicemails selected', 400, opts);
    // The list endpoint returns at most 200, so a larger selection can't have
    // come from the app. Also keeps the bind-parameter count well inside
    // SQLite's limit.
    if (ids.length > 200) return err('Too many voicemails at once (200 max)', 400, opts);

    const placeholders = ids.map(() => '?').join(',');

    if (action === 'purge') {
      const rows = await env.DB.prepare(
        `SELECT id, r2_key FROM voicemails WHERE id IN (${placeholders})`,
      ).bind(...ids).all();
      const doomed = rows.results || [];

      // Audio first, for the same reason as emptying the trash: a failure
      // here is retryable, the other order strands objects in R2.
      const keys = doomed.map((r) => r.r2_key).filter(Boolean);
      for (let i = 0; i < keys.length; i += 1000) {
        await env.AUDIO.delete(keys.slice(i, i + 1000));
      }

      await env.DB.prepare(`DELETE FROM voicemails WHERE id IN (${placeholders})`).bind(...ids).run();
      if (doomed.length) await audit(env.DB, 'voicemails_purged', { count: doomed.length }, req);
      return json({ ok: true, action, count: doomed.length }, opts);
    }

    const UPDATES = {
      save:    ['is_saved = 1'],
      unsave:  ['is_saved = 0'],
      read:    ['is_read = 1'],
      unread:  ['is_read = 0'],
      restore: ['deleted_at = NULL'],
    };

    let sql;
    let binds = ids;
    if (action === 'trash') {
      // Already-trashed messages keep their original deleted_at, so trashing
      // a mixed selection can't quietly extend anything's retention.
      sql = `UPDATE voicemails SET deleted_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
      binds = [now(), ...ids];
    // hasOwn, not a bare lookup: "constructor" and friends are inherited and
    // truthy, and would get past this to fail as a 500 further down.
    } else if (Object.hasOwn(UPDATES, action)) {
      sql = `UPDATE voicemails SET ${UPDATES[action].join(', ')} WHERE id IN (${placeholders})`;
    } else {
      return err(`Unknown action "${action}"`, 400, opts);
    }

    const result = await env.DB.prepare(sql).bind(...binds).run();
    return json({ ok: true, action, count: result.meta?.changes ?? ids.length }, opts);
  }

  // Empty the trash in one go, rather than deleting one at a time or waiting
  // out TRASH_RETENTION_DAYS. Scoped exactly like the nightly purge — trashed
  // and not saved — so it can only ever touch what is already in the trash,
  // and a saved message that was deleted still has to be deleted deliberately.
  if (path === '/api/trash' && req.method === 'DELETE') {
    const rows = await env.DB.prepare(
      'SELECT id, r2_key FROM voicemails WHERE deleted_at IS NOT NULL AND is_saved = 0',
    ).all();
    const doomed = rows.results || [];

    // Audio first: a failure here leaves the rows in place to try again,
    // where the reverse would strand unreachable objects in R2 forever.
    const keys = doomed.map((r) => r.r2_key).filter(Boolean);
    for (let i = 0; i < keys.length; i += 1000) {
      await env.AUDIO.delete(keys.slice(i, i + 1000)); // R2 caps a batch at 1000
    }

    await env.DB.prepare(
      'DELETE FROM voicemails WHERE deleted_at IS NOT NULL AND is_saved = 0',
    ).run();
    if (doomed.length) await audit(env.DB, 'trash_emptied', { count: doomed.length }, req);

    return json({ ok: true, deleted: doomed.length }, opts);
  }

  if (path === '/api/stats' && req.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT
         COUNT(*) FILTER (WHERE deleted_at IS NULL)                  AS total,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_read = 0)  AS unread,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_saved = 1) AS saved,
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)              AS trashed,
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL AND is_saved = 1) AS trashedSaved
       FROM voicemails`,
    ).first();
    // Retention travels with the stats so the trash can state its own rule
    // instead of the app hardcoding a number the Worker config can change.
    //
    // `features` lets the app tell what this Worker can do. The app deploys on
    // every push to main and the Worker only when asked, so the app can be the
    // newer of the two; without this it would offer controls that 404 until
    // the Worker catches up.
    return json({
      ...(row ?? {}),
      retentionDays: clampInt(env.TRASH_RETENTION_DAYS, 1, 3650, 30),
      features: ['emptyTrash', 'bulk'],
    }, opts);
  }

  /* ---- single item ---- */
  const idMatch = /^\/api\/voicemails\/([\w-]+)(\/[a-z]+)?$/.exec(path);
  if (idMatch) {
    const id = idMatch[1];
    const action = idMatch[2];

    const row = await env.DB.prepare('SELECT * FROM voicemails WHERE id = ?').bind(id).first();
    if (!row) return err('Voicemail not found', 404, opts);

    if (req.method === 'GET' && !action) {
      // Opening a voicemail marks it read — matches every other inbox.
      if (!row.is_read) {
        await env.DB.prepare('UPDATE voicemails SET is_read = 1 WHERE id = ?').bind(id).run();
        row.is_read = 1;
      }
      return json({
        ...shape(row),
        audioUrl: row.r2_key
          ? `${url.origin}/api/voicemails/${id}/audio?t=${await signAudioToken(env, id)}`
          : null,
      }, opts);
    }

    if (req.method === 'PATCH' && !action) {
      const body = await req.json().catch(() => ({}));
      const sets = [];
      const binds = [];
      if ('isRead' in body)  { sets.push('is_read = ?');  binds.push(body.isRead ? 1 : 0); }
      if ('isSaved' in body) { sets.push('is_saved = ?'); binds.push(body.isSaved ? 1 : 0); }
      if (!sets.length) return err('Nothing to update', 400, opts);

      await env.DB.prepare(`UPDATE voicemails SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds, id).run();

      const updated = await env.DB.prepare('SELECT * FROM voicemails WHERE id = ?').bind(id).first();
      return json(shape(updated), opts);
    }

    if (req.method === 'DELETE' && !action) {
      const permanent = url.searchParams.get('permanent') === '1';

      if (permanent) {
        if (row.r2_key) await env.AUDIO.delete(row.r2_key);
        await env.DB.prepare('DELETE FROM voicemails WHERE id = ?').bind(id).run();
        await audit(env.DB, 'voicemail_purged', { id }, req);
        return json({ ok: true, permanent: true }, opts);
      }

      // Soft delete: recoverable from Trash for TRASH_RETENTION_DAYS.
      await env.DB.prepare('UPDATE voicemails SET deleted_at = ? WHERE id = ?')
        .bind(now(), id).run();
      return json({ ok: true, permanent: false }, opts);
    }

    if (action === '/restore' && req.method === 'POST') {
      await env.DB.prepare('UPDATE voicemails SET deleted_at = NULL WHERE id = ?').bind(id).run();
      return json({ ok: true }, opts);
    }

    if (action === '/retranscribe' && req.method === 'POST') {
      if (!row.r2_key) return err('No audio stored for this voicemail', 400, opts);

      const object = await env.AUDIO.get(row.r2_key);
      if (!object) return err('Audio missing from storage', 404, opts);

      try {
        const result = await transcribe(env, await object.arrayBuffer());
        await env.DB.prepare(
          `UPDATE voicemails
              SET transcript = ?, transcript_status = 'done',
                  transcript_provider = ?, transcript_confidence = ?
            WHERE id = ?`,
        ).bind(result.text, result.provider, result.confidence ?? null, id).run();
        return json({ ok: true, transcript: result.text, provider: result.provider }, opts);
      } catch (e) {
        return err(`Transcription failed: ${e.message}`, 502, opts);
      }
    }
  }

  /* ---- push subscriptions ---- */
  if (path === '/api/push/subscribe' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return err('Invalid subscription', 400, opts);
    }
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(body.endpoint, body.keys.p256dh, body.keys.auth, now()).run();
    return json({ ok: true }, opts);
  }

  if (path === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
      .bind(body.endpoint).run();
    return json({ ok: true }, opts);
  }

  if (path === '/api/push/key' && req.method === 'GET') {
    return json({ publicKey: env.VAPID_PUBLIC_KEY || null }, opts);
  }

  return err('Not found', 404, opts);
}

/* ------------------------------------------------------------------ */
/* Audio streaming                                                     */
/* ------------------------------------------------------------------ */

const AUDIO_TOKEN_TTL = 6 * 3600; // long enough for a listening session

/**
 * HMAC over "voicemailId.expiry" using SESSION_SECRET. Scoped to one voicemail
 * and time-limited, so a leaked media URL can't be replayed or widened.
 */
async function signAudioToken(env, id) {
  const exp = now() + AUDIO_TOKEN_TTL;
  const sig = await hmacHex(env.SESSION_SECRET, `${id}.${exp}`);
  return `${exp}.${sig}`;
}

async function verifyAudioToken(env, id, token) {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = parseInt(expStr, 10);
  if (!exp || exp < now()) return false;
  return timingSafeEqual(sig || '', await hmacHex(env.SESSION_SECRET, `${id}.${exp}`));
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(sig);
}

async function streamAudio(req, env, id, token) {
  if (!(await verifyAudioToken(env, id, token))) {
    return new Response('Forbidden', { status: 403 });
  }

  const row = await env.DB.prepare('SELECT r2_key FROM voicemails WHERE id = ?').bind(id).first();
  if (!row?.r2_key) return new Response('Not found', { status: 404 });

  // Honour Range so scrubbing the audio player works properly.
  const range = req.headers.get('Range');
  const parsed = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

  const object = await env.AUDIO.get(row.r2_key, parsed ? {
    range: {
      offset: parsed[1] ? parseInt(parsed[1], 10) : undefined,
      length: parsed[2] ? parseInt(parsed[2], 10) - parseInt(parsed[1] || '0', 10) + 1 : undefined,
    },
  } : undefined);

  if (!object) return new Response('Not found', { status: 404 });

  const headers = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': env.APP_ORIGIN,
  };

  if (object.range && object.size !== undefined) {
    const start = object.range.offset ?? 0;
    const end = start + (object.range.length ?? object.size) - 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${object.size}`;
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}

/** Scheduled cleanup: purge trashed, unsaved voicemails past the retention window. */
export async function purgeTrash(env) {
  const days = parseInt(env.TRASH_RETENTION_DAYS || '30', 10);
  const cutoff = now() - days * 86400;

  const rows = await env.DB.prepare(
    'SELECT id, r2_key FROM voicemails WHERE deleted_at IS NOT NULL AND deleted_at < ? AND is_saved = 0',
  ).bind(cutoff).all();

  for (const row of rows.results || []) {
    if (row.r2_key) await env.AUDIO.delete(row.r2_key);
    await env.DB.prepare('DELETE FROM voicemails WHERE id = ?').bind(row.id).run();
  }

  if ((rows.results || []).length) {
    await audit(env.DB, 'trash_purged', { count: rows.results.length });
  }
}
