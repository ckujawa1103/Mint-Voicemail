// Working out who actually called.
//
// The phone number is a poor identity. A collection agency will reach you from
// a dozen numbers in a month; a clinic calls from whichever line is free. But
// callers say who they are out loud — "this is Denise from Meridian Recovery" —
// so the transcript carries the identity the number doesn't.
//
// So: extract the organisation from the transcript, resolve it to a caller
// entity, and attach the number to that entity. Numbers accumulate under the
// caller over time, which is what makes one agency's twelve numbers collapse
// into one group.

import { now, randomToken, audit } from './util.js';

/* ------------------------------------------------------------------ */
/* Model selection                                                     */
/* ------------------------------------------------------------------ */

// Tried in order. Availability varies by account and changes over time, and
// the API token used for deploys can't necessarily list models — so rather
// than pin one and break, fall down the list and remember what worked.
const MODEL_CANDIDATES = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
];

const MODEL_STATE_KEY = 'ai_model';

async function getRememberedModel(env) {
  const row = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?')
    .bind(MODEL_STATE_KEY).first();
  return row?.value ?? null;
}

async function rememberModel(env, model) {
  await env.DB.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(MODEL_STATE_KEY, model).run();
}

/**
 * Pull the generated text out of a Workers AI response.
 *
 * Current models answer in OpenAI's shape, where the text is under
 * choices[0].message.content and the top-level `response` key holds an object
 * — reading `response` and assuming a string is the obvious mistake here.
 * Older models did return a plain string there, so both are handled.
 */
function extractText(result) {
  if (typeof result === 'string') return result;

  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === 'string' && choice.trim()) return choice;

  const response = result?.response;
  if (typeof response === 'string' && response.trim()) return response;
  // A model doing structured output hands back an object already parsed.
  if (response && typeof response === 'object' && !Array.isArray(response)) return response;

  return null;
}

async function runModel(env, prompt) {
  if (!env.AI) throw new Error('Workers AI binding is not configured');

  const remembered = await getRememberedModel(env);
  const order = remembered
    ? [remembered, ...MODEL_CANDIDATES.filter((m) => m !== remembered)]
    : MODEL_CANDIDATES;

  let lastError;
  for (const model of order) {
    try {
      const result = await env.AI.run(model, {
        messages: [
          {
            role: 'system',
            content:
              'You extract structured data from voicemail transcripts. ' +
              'You reply with one JSON object and nothing else — no prose, no code fence.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0,
      });

      const payload = extractText(result);
      if (payload === null) throw new Error('no text in model response');

      if (model !== remembered) await rememberModel(env, model);
      return payload;
    } catch (e) {
      lastError = e;
      // Model unavailable for this account, or transiently failing. Next one.
    }
  }
  throw lastError ?? new Error('no usable model');
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

export const CATEGORIES = [
  'debt_collection', 'sales', 'medical', 'financial', 'delivery',
  'government', 'legal', 'scam_or_spam', 'personal', 'other',
];

function buildPrompt(transcript, cnam) {
  return `Extract who is calling from this voicemail transcript.

Reply with ONLY this JSON object:
{"org": string|null, "person": string|null, "category": string, "callback": string|null, "summary": string}

Rules:
- "org": the company or organisation the caller represents. Use the name they
  say, without legal suffixes like LLC or Inc. null for a personal call.
- "person": the individual caller's own name, or null.
- "category": exactly one of ${CATEGORIES.join(', ')}.
- "callback": a phone number they ask to be called back on, digits only, or null.
- "summary": under 12 words, plain and factual.
- If the transcript is empty, noise, or says nothing identifying, use
  {"org":null,"person":null,"category":"other","callback":null,"summary":"No message"}.
${cnam ? `\nThe carrier reports the caller ID name as "${cnam}", which may help.` : ''}

Transcript:
"""
${transcript.slice(0, 3000)}
"""`;
}

/**
 * Models wrap JSON in prose or fences no matter how firmly you ask them not
 * to, so pull out the first balanced object rather than trusting the shape.
 */
function parseJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export async function extractCallerInfo(env, transcript, cnam) {
  const clean = (transcript || '').trim();
  if (!clean || clean === '(no speech detected)') {
    return { org: null, person: null, category: 'other', callback: null, summary: 'No message' };
  }

  const raw = await runModel(env, buildPrompt(clean, cnam));

  // Already an object when the model does structured output; otherwise dig
  // the JSON out of whatever prose it wrapped around it.
  const parsed = typeof raw === 'string'
    ? parseJsonObject(raw)
    : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);

  if (!parsed) {
    const preview = typeof raw === 'string' ? raw.slice(0, 120) : `${typeof raw}: ${JSON.stringify(raw).slice(0, 120)}`;
    throw new Error(`could not parse model output — ${preview}`);
  }

  const str = (v) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null'
    ? v.trim().slice(0, 120) : null);

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'other';

  return {
    org: str(parsed.org),
    person: str(parsed.person),
    category,
    callback: str(parsed.callback)?.replace(/[^\d+]/g, '') || null,
    summary: str(parsed.summary) || null,
  };
}

/* ------------------------------------------------------------------ */
/* Identity resolution                                                 */
/* ------------------------------------------------------------------ */

// Dropped when building the matching key. These are the words that differ
// between "Meridian Recovery LLC" and "Meridian Recovery Associates" while
// meaning the same outfit.
const GENERIC_TOKENS = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'lp', 'llp', 'pllc', 'pc', 'plc',
  'group', 'associates', 'association', 'partners', 'holdings',
  'services', 'service', 'solutions', 'systems', 'agency', 'agencies',
  'the', 'and', 'of', 'a', 'an',
]);

/**
 * Normalized matching key for an organisation name.
 *
 * Deliberately keeps the distinctive words and drops the corporate furniture,
 * so the same outfit matches across the small variations in how staff say the
 * name. Never strips down to nothing: if every token is generic, the full
 * normalized name is kept rather than collapsing unrelated callers together.
 */
export function slugify(name) {
  const words = String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const significant = words.filter((w) => !GENERIC_TOKENS.has(w));
  return (significant.length ? significant : words).join('-');
}

/**
 * Conservative fuzzy match against existing groups.
 *
 * Requires one slug's significant tokens to be a subset of the other's, with
 * at least two tokens shared — so "meridian-recovery" matches
 * "meridian-recovery-northeast" but "recovery-services" does not swallow every
 * other agency with "recovery" in the name. Anything looser produces wrong
 * merges, which are far more annoying than a missed one: the user can merge
 * groups by hand, but un-merging means re-sorting a pile.
 */
function looksLikeSameOrg(a, b) {
  if (a === b) return true;

  const ta = new Set(a.split('-'));
  const tb = new Set(b.split('-'));
  const shared = [...ta].filter((t) => tb.has(t));
  if (shared.length < 2) return false;

  return shared.length === ta.size || shared.length === tb.size;
}

/**
 * Find the caller entity for an organisation name, creating it if new.
 * Returns null when there's no name to group on.
 */
export async function resolveCaller(env, { org, person, category }) {
  // A personal call has no organisation; group it under the person instead.
  const name = org || person;
  if (!name) return null;

  const slug = slugify(name);
  if (!slug) return null;

  const exact = await env.DB.prepare('SELECT id, pinned FROM callers WHERE slug = ?')
    .bind(slug).first();
  if (exact) return exact.id;

  const all = await env.DB.prepare('SELECT id, slug FROM callers').all();
  for (const row of all.results || []) {
    if (looksLikeSameOrg(slug, row.slug)) return row.id;
  }

  const id = randomToken(9);
  await env.DB.prepare(
    `INSERT INTO callers (id, name, slug, category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, name, slug, category ?? null, now(), now()).run();

  return id;
}

/** Record that a number belongs to a caller, and that it just called. */
async function linkNumber(env, number, callerId) {
  if (!number || !callerId) return;
  const t = now();
  await env.DB.prepare(
    `INSERT INTO caller_numbers (number, caller_id, first_seen, last_seen, call_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(number) DO UPDATE SET
       last_seen  = excluded.last_seen,
       call_count = caller_numbers.call_count + 1,
       -- Only adopt the new caller when the number wasn't already attributed.
       -- A number that has been assigned, especially by hand, shouldn't move
       -- because one transcript was misheard.
       caller_id  = CASE WHEN caller_numbers.caller_id IS NULL
                         THEN excluded.caller_id ELSE caller_numbers.caller_id END`,
  ).bind(number, callerId, t, t).run();
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Identify one voicemail and file it under a caller.
 *
 * Never throws: identification is an enhancement, and a voicemail that can't
 * be attributed is still a voicemail. Failures are recorded on the row so the
 * UI can offer a retry.
 */
export async function identifyVoicemail(env, vm) {
  try {
    // A number already attributed to a caller is the strongest signal there
    // is — no model needed to know who it is.
    const known = vm.from_number
      ? await env.DB.prepare(
          `SELECT c.id, c.name, c.category FROM caller_numbers n
             JOIN callers c ON c.id = n.caller_id
            WHERE n.number = ?`,
        ).bind(vm.from_number).first()
      : null;

    const info = await extractCallerInfo(env, vm.transcript, vm.from_name);

    // Extraction still runs even for a known number, because the summary and
    // the individual caller's name are per-message. But the existing
    // attribution wins over a fresh guess.
    const callerId = known?.id ?? await resolveCaller(env, info);

    await linkNumber(env, vm.from_number, callerId);

    await env.DB.prepare(
      `UPDATE voicemails
          SET caller_id = ?, caller_person = ?, caller_callback = ?,
              summary = ?, identify_status = 'done'
        WHERE id = ?`,
    ).bind(callerId, info.person, info.callback, info.summary, vm.id).run();

    // Category is a property of the group, so let a confident extraction fill
    // one in — but never overwrite a category the user set by hand.
    if (callerId && info.category && info.category !== 'other') {
      await env.DB.prepare(
        `UPDATE callers SET category = ?, updated_at = ?
          WHERE id = ? AND pinned = 0 AND (category IS NULL OR category = 'other')`,
      ).bind(info.category, now(), callerId).run();
    }

    return { callerId, ...info };
  } catch (e) {
    await env.DB.prepare(
      "UPDATE voicemails SET identify_status = 'failed' WHERE id = ?",
    ).bind(vm.id).run();
    await audit(env.DB, 'identify_failed', { id: vm.id, error: String(e) });
    return null;
  }
}
