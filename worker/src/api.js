// Voicemail CRUD, audio streaming, and push-subscription management.

import {
  now, json, err, sha256, b64urlEncode, timingSafeEqual,
  audit, formatPhone, clampInt, corsHeaders,
} from './util.js';
import { requireSession } from './auth.js';
import { transcribe } from './transcribe.js';
import { identifyVoicemail, CATEGORIES } from './identify.js';

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
    callerId: row.caller_id,
    callerName: row.caller_name,
    callerCategory: row.caller_category,
    callerPerson: row.caller_person,
    callerCallback: row.caller_callback,
    summary: row.summary,
    identifyStatus: row.identify_status,
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

  // Contact card for every identified caller.
  //
  // This is the answer to "tell me who it is before I answer": import it into
  // your phone's contacts and the dialer shows the group's name natively,
  // across every number that caller uses. A web app can't screen a live call,
  // but the phone already does exactly that for known contacts.
  //
  // Authenticated by a short-lived signed token rather than the session, for
  // the same reason as audio: a plain download can't carry an Authorization
  // header. The signature is scoped to this one export and expires.
  if (path === '/api/callers/export.vcf' && req.method === 'GET') {
    if (!(await verifyAudioToken(env, EXPORT_SCOPE, url.searchParams.get('t')))) {
      return new Response('Forbidden', { status: 403 });
    }

    const rows = await env.DB.prepare(
      `SELECT c.name, c.category,
              (SELECT GROUP_CONCAT(n.number)
                 FROM caller_numbers n WHERE n.caller_id = c.id) AS numbers
         FROM callers c
        ORDER BY c.name`,
    ).all();

    const cards = [];
    for (const row of rows.results || []) {
      const numbers = (row.numbers || '').split(',').filter(Boolean);
      if (!numbers.length) continue;

      const label = row.category && row.category !== 'other'
        ? `${row.name} (${row.category.replace(/_/g, ' ')})`
        : row.name;

      cards.push([
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${vcardEscape(label)}`,
        `N:${vcardEscape(label)};;;;`,
        `ORG:${vcardEscape(row.name)}`,
        ...numbers.map((n) => `TEL;TYPE=WORK,VOICE:${n}`),
        `NOTE:${vcardEscape(`Identified from voicemail. ${numbers.length} number(s) seen.`)}`,
        'END:VCARD',
      ].join('\r\n'));
    }

    return new Response(cards.join('\r\n') + (cards.length ? '\r\n' : ''), {
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': 'attachment; filename="voicemail-callers.vcf"',
        'Cache-Control': 'no-store',
      },
    });
  }

  const session = await requireSession(req, env);
  if (!session) return err('Not signed in', 401, opts);

  /* ---- collection ---- */
  if (path === '/api/voicemails' && req.method === 'GET') {
    // Clear out abandoned calls before reading, so the list is already correct
    // rather than correct-by-tomorrow. One indexed UPDATE that usually matches
    // nothing at all.
    await sweepAbandoned(env);

    const filter = url.searchParams.get('filter') || 'inbox';
    const q = (url.searchParams.get('q') || '').trim();
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);

    // Columns are qualified throughout: joining callers brings id, name,
    // category and created_at into scope, all of which collide.
    let where;
    if (filter === 'trash') where = 'v.deleted_at IS NOT NULL';
    else if (filter === 'saved') where = 'v.deleted_at IS NULL AND v.is_saved = 1';
    else if (filter === 'unread') where = 'v.deleted_at IS NULL AND v.is_read = 0';
    else where = 'v.deleted_at IS NULL';

    const binds = [];

    // Narrow to one caller group — every number that entity has ever used.
    const callerId = url.searchParams.get('callerId');
    if (callerId) {
      where += ' AND v.caller_id = ?';
      binds.push(callerId);
    }

    if (q) {
      // Searching the caller name too, so "meridian" finds the group's
      // messages even when the transcript never spells it that way.
      where += ' AND (v.transcript LIKE ? OR v.from_number LIKE ?'
             + ' OR v.from_name LIKE ? OR v.summary LIKE ? OR c.name LIKE ?)';
      const like = `%${q}%`;
      binds.push(like, like, like, like, like);
    }

    const rows = await env.DB.prepare(
      `SELECT v.*, c.name AS caller_name, c.category AS caller_category
         FROM voicemails v
         LEFT JOIN callers c ON c.id = v.caller_id
        WHERE ${where}
        ORDER BY v.created_at DESC
        LIMIT ?`,
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
      features: ['emptyTrash', 'bulk', 'callers'],
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

  /* ---- caller groups ---- */

  // One row per caller entity, with every number it has used and how often.
  if (path === '/api/callers' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.name, c.category, c.note, c.pinned,
              COUNT(v.id)                                          AS total,
              SUM(CASE WHEN v.is_read = 0 THEN 1 ELSE 0 END)        AS unread,
              MAX(v.created_at)                                     AS last_call,
              (SELECT GROUP_CONCAT(n.number)
                 FROM caller_numbers n WHERE n.caller_id = c.id)    AS numbers
         FROM callers c
         LEFT JOIN voicemails v ON v.caller_id = c.id AND v.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY last_call DESC NULLS LAST, c.name`,
    ).all();

    return json({
      callers: (rows.results || []).map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        note: r.note,
        pinned: !!r.pinned,
        total: r.total ?? 0,
        unread: r.unread ?? 0,
        lastCall: r.last_call,
        numbers: r.numbers ? r.numbers.split(',') : [],
      })),
      categories: CATEGORIES,
      exportUrl: `${url.origin}/api/callers/export.vcf`
                 + `?t=${await signAudioToken(env, EXPORT_SCOPE)}`,
    }, opts);
  }

  // Identify everything that hasn't been done yet.
  //
  // Batched rather than all-at-once: each one is a model call, and a request
  // that tried to do hundreds would exceed the Worker's time budget and lose
  // the lot. The client calls this repeatedly until `remaining` reaches zero,
  // so progress is durable across batches.
  if (path === '/api/callers/identify-pending' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const batch = clampInt(body.batch, 1, 10, 5);

    const rows = await env.DB.prepare(
      `SELECT id, from_number, from_name, transcript
         FROM voicemails
        WHERE transcript_status = 'done'
          AND (identify_status IS NULL OR identify_status = 'pending')
        ORDER BY created_at DESC
        LIMIT ?`,
    ).bind(batch).all();

    let done = 0;
    for (const vm of rows.results || []) {
      if (await identifyVoicemail(env, vm)) done++;
    }

    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM voicemails
        WHERE transcript_status = 'done'
          AND (identify_status IS NULL OR identify_status = 'pending')`,
    ).first();

    return json({ ok: true, identified: done, remaining: left?.n ?? 0 }, opts);
  }

  const callerMatch = /^\/api\/callers\/([\w-]+)(\/merge)?$/.exec(path);
  if (callerMatch && callerMatch[1] !== 'export.vcf') {
    const callerId = callerMatch[1];
    const merging = !!callerMatch[2];

    // Renaming or recategorising is a human correction, so it pins the group:
    // later extractions may add numbers to it but must not rewrite the label.
    if (req.method === 'PATCH' && !merging) {
      const body = await req.json().catch(() => ({}));
      const sets = [];
      const binds = [];

      if (typeof body.name === 'string' && body.name.trim()) {
        sets.push('name = ?', 'pinned = 1');
        binds.push(body.name.trim().slice(0, 120));
      }
      if (typeof body.category === 'string' && CATEGORIES.includes(body.category)) {
        sets.push('category = ?', 'pinned = 1');
        binds.push(body.category);
      }
      if (typeof body.note === 'string') {
        sets.push('note = ?');
        binds.push(body.note.slice(0, 500));
      }
      if (!sets.length) return err('Nothing to update', 400, opts);

      sets.push('updated_at = ?');
      binds.push(now());

      await env.DB.prepare(`UPDATE callers SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds, callerId).run();

      return json({ ok: true }, opts);
    }

    // Fold one group into another: the correction for a caller that got split
    // across two entries because they introduced themselves differently.
    if (req.method === 'POST' && merging) {
      const body = await req.json().catch(() => ({}));
      const into = body.into;
      if (!into || into === callerId) return err('Choose a different group to merge into', 400, opts);

      const target = await env.DB.prepare('SELECT id FROM callers WHERE id = ?').bind(into).first();
      if (!target) return err('Target group not found', 404, opts);

      await env.DB.batch([
        env.DB.prepare('UPDATE voicemails SET caller_id = ? WHERE caller_id = ?').bind(into, callerId),
        env.DB.prepare('UPDATE caller_numbers SET caller_id = ? WHERE caller_id = ?').bind(into, callerId),
        // The surviving group is now a human judgement, so pin it.
        env.DB.prepare('UPDATE callers SET pinned = 1, updated_at = ? WHERE id = ?').bind(now(), into),
        env.DB.prepare('DELETE FROM callers WHERE id = ?').bind(callerId),
      ]);

      await audit(env.DB, 'callers_merged', { from: callerId, into }, req);
      return json({ ok: true }, opts);
    }

    // Deleting a group only ungroups it; the voicemails themselves stay.
    if (req.method === 'DELETE' && !merging) {
      await env.DB.batch([
        env.DB.prepare("UPDATE voicemails SET caller_id = NULL, identify_status = 'pending' WHERE caller_id = ?").bind(callerId),
        env.DB.prepare('DELETE FROM caller_numbers WHERE caller_id = ?').bind(callerId),
        env.DB.prepare('DELETE FROM callers WHERE id = ?').bind(callerId),
      ]);
      return json({ ok: true }, opts);
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

/** vCard escapes commas, semicolons, backslashes and newlines. */
function vcardEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/* ------------------------------------------------------------------ */
/* Audio streaming                                                     */
/* ------------------------------------------------------------------ */

// Scope string for the contacts export, signed with the same HMAC helper as
// audio URLs — the "id" being signed is a fixed scope rather than a row id.
const EXPORT_SCOPE = 'callers-export';

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

// How long to wait before deciding a call left no message. Twilio's recording
// callback normally lands within seconds of the caller hanging up; this is
// generous enough that a slow one can never be mistaken for an abandoned call.
const ABANDONED_GRACE_SEC = 10 * 60;

/**
 * Move calls that left no recording to the Trash.
 *
 * A row is created when the call is answered, so the caller ID survives even
 * if the caller hangs up during the greeting. When they do hang up early,
 * Twilio sends no recording callback at all — so nothing else would ever clean
 * these up, and they pile up in the inbox as 0-second entries with no audio.
 *
 * Trashed rather than deleted, so an unexpected one is still visible, and
 * marked read so they never inflate the unread badge. The nightly purge then
 * clears them on the normal retention schedule.
 */
export async function sweepAbandoned(env) {
  const result = await env.DB.prepare(
    `UPDATE voicemails
        SET deleted_at = ?, is_read = 1
      WHERE r2_key IS NULL
        AND deleted_at IS NULL
        AND created_at < ?`,
  ).bind(now(), now() - ABANDONED_GRACE_SEC).run();

  const moved = result.meta?.changes ?? 0;
  if (moved) await audit(env.DB, 'abandoned_calls_trashed', { count: moved });
  return moved;
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
