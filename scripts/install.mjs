#!/usr/bin/env node
/**
 * One-command setup for a personal voicemail system.
 *
 * Provisions everything into YOUR OWN Cloudflare and Twilio accounts — nobody
 * else ever holds your voicemail. Takes about two minutes; the manual version
 * of this takes a few hours and has roughly a dozen places to go wrong.
 *
 *   node scripts/install.mjs
 *
 * You'll be asked for four API keys. Nothing is transmitted anywhere except
 * directly to Cloudflare, Twilio, and AssemblyAI.
 *
 * Safe to re-run: existing resources are reused rather than duplicated.
 */

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = join(ROOT, 'worker');
const WEB_DIR = join(ROOT, 'web');

const rl = createInterface({ input: stdin, output: stdout });

/* ------------------------------------------------------------------ */
/* Output helpers                                                      */
/* ------------------------------------------------------------------ */

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let stepNo = 0;
const step = (msg) => console.log(`\n${c.bold(`[${++stepNo}]`)} ${msg}`);
const ok = (msg) => console.log(`    ${c.green('✓')} ${msg}`);
const info = (msg) => console.log(`    ${c.dim(msg)}`);

function die(msg, hint) {
  console.error(`\n${c.red('✗')} ${msg}`);
  if (hint) console.error(`  ${c.dim(hint)}`);
  rl.close();
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Shell + HTTP                                                        */
/* ------------------------------------------------------------------ */

function sh(cmd, args, { cwd = WORKER_DIR, env = {}, input } = {}) {
  return execFileSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: input === undefined ? ['inherit', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

const wrangler = (args, opts = {}) => sh('npx', ['wrangler', ...args], opts);

async function cf(path, token, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  return res.json();
}

async function twilio(path, sid, token, form) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Twilio ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

async function ask(question, { validate, hint, optional = false } = {}) {
  for (;;) {
    if (hint) console.log(c.dim(`    ${hint}`));
    const answer = (await rl.question(`    ${question}: `)).trim();

    if (!answer && optional) return '';
    if (!answer) { console.log(c.red('    Required.')); continue; }

    const problem = validate?.(answer);
    if (problem) { console.log(c.red(`    ${problem}`)); continue; }
    return answer;
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

console.log(`
${c.bold('Voicemail — setup')}

Provisions a private voicemail system into your own Cloudflare and Twilio
accounts. Your recordings and transcripts stay in infrastructure you control.

You'll need four things. Links are shown as we go.
`);

/* ---- 1. credentials ---- */

step('Cloudflare');
const cfToken = await ask('API token', {
  hint: 'Create at dash.cloudflare.com/profile/api-tokens → "Edit Cloudflare Workers" template, plus a D1:Edit row.',
  validate: (v) => (v.length < 20 ? 'That looks too short.' : null),
});

const verify = await cf('/user/tokens/verify', cfToken);
if (!verify.success) die('Cloudflare rejected that token.', 'Check it was copied in full.');
ok('token valid');

const accounts = await cf('/accounts', cfToken);
if (!accounts.success || !accounts.result?.length) {
  die('No Cloudflare accounts visible to this token.', 'The token needs Account Settings: Read.');
}
const accountId = accounts.result[0].id;
ok(`account: ${accounts.result[0].name}`);

// The workers.dev subdomain determines the app URL, and the URL must be known
// before deploy because WebAuthn and CORS are both pinned to it.
const sub = await cf(`/accounts/${accountId}/workers/subdomain`, cfToken);
if (!sub.success || !sub.result?.subdomain) {
  die('Could not read your workers.dev subdomain.', 'Visit the Workers dashboard once to claim one, then re-run.');
}
const subdomain = sub.result.subdomain;
ok(`subdomain: ${subdomain}.workers.dev`);

step('Twilio');
const twSid = await ask('Account SID', {
  hint: 'Both are on the console.twilio.com dashboard under Account Info.',
  validate: (v) => (/^AC[0-9a-f]{32}$/i.test(v) ? null : 'Should start with AC followed by 32 hex characters.'),
});
const twToken = await ask('Auth token', { validate: (v) => (v.length < 20 ? 'That looks too short.' : null) });

let account;
try {
  account = await twilio('.json', twSid, twToken);
} catch {
  die('Twilio rejected those credentials.');
}
ok(`account: ${account.friendly_name} (${account.type})`);
if (account.type === 'Trial') {
  console.log(c.yellow('    ! Trial accounts cannot buy numbers. Upgrade first, then re-run.'));
}

step('AssemblyAI');
const aaiKey = await ask('API key', { hint: 'Free key at assemblyai.com/app/account' });

step('You');
const email = await ask('Your email address', {
  hint: 'The only address allowed to sign in, and where recovery links go.',
  validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "That doesn't look like an email address."),
});
const resendKey = await ask('Resend API key (optional, press Enter to skip)', {
  hint: 'Enables emailed sign-in links as a backup way in. Free at resend.com.',
  optional: true,
});

const workerName = await ask('Name for this deployment', {
  hint: 'Becomes part of your URL. Lowercase letters, numbers and dashes.',
  validate: (v) => (/^[a-z0-9][a-z0-9-]{1,40}$/.test(v) ? null : 'Lowercase letters, numbers and dashes only.'),
});

const appOrigin = `https://${workerName}.${subdomain}.workers.dev`;
const rpId = `${workerName}.${subdomain}.workers.dev`;

/* ---- 2. provision ---- */

const env = { CLOUDFLARE_API_TOKEN: cfToken, CLOUDFLARE_ACCOUNT_ID: accountId };
const d1Name = `${workerName}-db`;
const r2Name = `${workerName}-audio`;

step('Creating database and storage');

let d1Id;
try {
  const out = wrangler(['d1', 'create', d1Name], { env });
  d1Id = /database_id = "([^"]+)"/.exec(out)?.[1];
  ok(`database created: ${d1Name}`);
} catch {
  // Already exists from a previous run — look up its id instead of failing.
  const list = await cf(`/accounts/${accountId}/d1/database?name=${d1Name}`, cfToken);
  d1Id = list.result?.find((d) => d.name === d1Name)?.uuid;
  if (!d1Id) die(`Could not create or find the database "${d1Name}".`);
  info('database already existed, reusing it');
}

try {
  wrangler(['r2', 'bucket', 'create', r2Name], { env });
  ok(`storage created: ${r2Name}`);
} catch (e) {
  if (String(e.stdout ?? e).includes('10042')) {
    die('R2 is not enabled on your Cloudflare account.',
        'Open dash.cloudflare.com → R2 Object Storage → enable it, then re-run this.');
  }
  info('storage already existed, reusing it');
}

/* ---- 3. config ---- */

step('Writing configuration');
const template = readFileSync(join(WORKER_DIR, 'wrangler.template.toml'), 'utf8');
const config = template
  .replaceAll('{{WORKER_NAME}}', workerName)
  .replaceAll('{{D1_NAME}}', d1Name)
  .replaceAll('{{D1_ID}}', d1Id)
  .replaceAll('{{R2_BUCKET}}', r2Name)
  .replaceAll('{{APP_ORIGIN}}', appOrigin)
  .replaceAll('{{RP_ID}}', rpId)
  .replaceAll('{{GREETING}}',
    "Hi, you've reached me. I can't take your call right now. Please leave a message after the tone.");

writeFileSync(join(WORKER_DIR, 'wrangler.toml'), config);
ok('wrangler.toml written');

step('Creating database tables');
wrangler(['d1', 'execute', d1Name, '--remote', '--file=./schema.sql', '-y'], { env });
ok('9 tables created');

/* ---- 4. secrets ---- */

step('Generating keys');
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapidPublic = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const vapidPrivate = (await webcrypto.subtle.exportKey('jwk', keys.privateKey)).d;
const sessionSecret = randomBytes(32).toString('base64url');
const setupCode = randomBytes(6).toString('base64url');
ok('push keys, session secret, and setup code generated');

step('Storing secrets');
const secrets = {
  TWILIO_ACCOUNT_SID: twSid,
  TWILIO_AUTH_TOKEN: twToken,
  TRANSCRIBE_API_KEY: aaiKey,
  OWNER_EMAIL: email,
  SESSION_SECRET: sessionSecret,
  SETUP_CODE: setupCode,
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_PRIVATE_KEY: vapidPrivate,
  ...(resendKey ? { RESEND_API_KEY: resendKey } : {}),
};

for (const [name, value] of Object.entries(secrets)) {
  wrangler(['secret', 'put', name], { env, input: value });
}
ok(`${Object.keys(secrets).length} secrets stored`);

/* ---- 5. build + deploy ---- */

step('Building the app');
sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: WEB_DIR });
sh('npm', ['run', 'build'], { cwd: WEB_DIR, env: { VITE_API_BASE: '', BASE_PATH: '/' } });
ok('app built');

step('Deploying');
wrangler(['deploy'], { env });
ok(`live at ${appOrigin}`);

/* ---- 6. phone number ---- */

step('Setting up your phone number');
const owned = await twilio('/IncomingPhoneNumbers.json?PageSize=50', twSid, twToken);
let number = owned.incoming_phone_numbers?.find((n) => n.capabilities?.voice);

if (number) {
  info(`reusing existing number ${number.phone_number}`);
} else {
  const search = await twilio('/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=5', twSid, twToken);
  const pick = search.available_phone_numbers?.[0];
  if (!pick) die('No voice-capable numbers available on your Twilio account.');
  number = await twilio('/IncomingPhoneNumbers.json', twSid, twToken, {
    PhoneNumber: pick.phone_number,
    FriendlyName: 'Voicemail',
  });
  ok(`purchased ${number.phone_number}`);
}

await twilio(`/IncomingPhoneNumbers/${number.sid}.json`, twSid, twToken, {
  VoiceUrl: `${appOrigin}/twilio/voice`,
  VoiceMethod: 'POST',
});
ok('voice webhook attached');

/* ---- done ---- */

const digits = number.phone_number.replace(/^\+1/, '');

console.log(`
${c.green('━'.repeat(64))}
${c.bold('  Done.')}

  ${c.bold('Open your app')}
      ${appOrigin}

  ${c.bold('Setup code')} — creates your account, used once
      ${c.bold(setupCode)}

  ${c.bold('Then turn on call forwarding')} from your phone's dialer:
      ${c.bold(`**004*${digits}#`)}      then press call

      Only calls you DON'T answer are forwarded. Outgoing calls
      and texts are unaffected. To undo it later: ##004#

  ${c.dim(`Your number: ${number.phone_number}`)}
  ${c.dim('Save your recovery codes when the app shows them — they appear once.')}
${c.green('━'.repeat(64))}
`);

rl.close();
