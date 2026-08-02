#!/usr/bin/env node
/**
 * Buys a voice-capable US number and points it at your Worker.
 *
 * Run this yourself so your Twilio credentials stay on your machine:
 *
 *   TWILIO_ACCOUNT_SID=ACxxxx \
 *   TWILIO_AUTH_TOKEN=xxxx \
 *   WORKER_URL=https://mint-voicemail.you.workers.dev \
 *   node scripts/setup-twilio.mjs
 *
 * Optional:
 *   AREA_CODE=631     prefer a specific area code
 *   DRY_RUN=1         search and report, but don't buy anything
 *
 * Already own a number? This finds it and reconfigures it instead of buying
 * a second one, so it's safe to re-run.
 */

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WORKER_URL = process.env.WORKER_URL?.replace(/\/+$/, '');
const AREA_CODE = process.env.AREA_CODE;
const DRY_RUN = process.env.DRY_RUN === '1';

const API = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!SID || !TOKEN) die('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
if (!WORKER_URL) die('Set WORKER_URL to your deployed Worker URL.');
if (!/^AC[0-9a-f]{32}$/i.test(SID)) die('TWILIO_ACCOUNT_SID should start with "AC".');

async function twilio(path, { method = 'GET', form } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: auth,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Twilio's own error text is more useful than anything we'd invent.
    throw new Error(`${res.status} ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

const VOICE_URL = `${WORKER_URL}/twilio/voice`;

const webhookConfig = {
  VoiceUrl: VOICE_URL,
  VoiceMethod: 'POST',
  // If the Worker ever errors, the caller hears Twilio's default message
  // rather than dead air.
  VoiceFallbackUrl: '',
  FriendlyName: 'Mint Voicemail',
};

async function main() {
  console.log(`\nWorker voice webhook: ${VOICE_URL}\n`);

  // 1. Reuse an existing number if there is one.
  const owned = await twilio('/IncomingPhoneNumbers.json?PageSize=50');
  const existing = owned.incoming_phone_numbers?.find((n) => n.capabilities?.voice);

  if (existing) {
    console.log(`Found an existing voice number: ${existing.phone_number}`);
    if (DRY_RUN) {
      console.log('DRY_RUN set — not modifying it.');
      return report(existing.phone_number);
    }
    await twilio(`/IncomingPhoneNumbers/${existing.sid}.json`, {
      method: 'POST',
      form: webhookConfig,
    });
    console.log('✓ Reconfigured its voice webhook.');
    return report(existing.phone_number);
  }

  // 2. Otherwise find one to buy.
  const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '5' });
  if (AREA_CODE) query.set('AreaCode', AREA_CODE);

  const search = await twilio(`/AvailablePhoneNumbers/US/Local.json?${query}`);
  const candidates = search.available_phone_numbers || [];

  if (!candidates.length) {
    die(AREA_CODE
      ? `No voice numbers available in area code ${AREA_CODE}. Try another, or omit AREA_CODE.`
      : 'No voice numbers available. This is unusual — check your Twilio account status.');
  }

  const pick = candidates[0];
  console.log(`Available: ${candidates.map((c) => c.phone_number).join(', ')}`);
  console.log(`Selecting: ${pick.phone_number}`);

  if (DRY_RUN) {
    console.log('\nDRY_RUN set — nothing purchased.');
    return;
  }

  // 3. Buy it with the webhook already attached, so there's no window where
  //    the number exists but calls go nowhere.
  const bought = await twilio('/IncomingPhoneNumbers.json', {
    method: 'POST',
    form: { PhoneNumber: pick.phone_number, ...webhookConfig },
  });

  console.log(`✓ Purchased ${bought.phone_number}`);
  report(bought.phone_number);
}

function report(e164) {
  const digits = e164.replace(/^\+1/, '');
  console.log(`
─────────────────────────────────────────────
  Your voicemail number: ${e164}

  Now turn on conditional call forwarding from
  your Mint phone's dialer:

      **004*${digits}#        then press call

  To undo it later:

      ##004#

  Only calls you DON'T answer are forwarded.
  Outgoing calls and texts are unaffected.
─────────────────────────────────────────────
`);
}

main().catch((e) => {
  const msg = String(e.message);
  if (msg.includes('20003')) {
    die('Authentication failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
  }
  if (msg.includes('21404') || msg.toLowerCase().includes('insufficient')) {
    die('Insufficient funds. Trial accounts must be upgraded before buying a number.');
  }
  die(msg);
});
