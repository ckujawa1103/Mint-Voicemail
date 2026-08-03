#!/usr/bin/env node
/**
 * One-command setup for a personal voicemail system.
 *
 * Provisions everything into YOUR OWN Cloudflare and Twilio accounts — nobody
 * else ever holds your voicemail. Takes about two minutes; the manual version
 * of this takes a few hours and has roughly a dozen places to go wrong.
 *
 *   npm run setup
 *
 * You'll be asked for four API keys. Nothing is transmitted anywhere except
 * directly to Cloudflare, Twilio, and AssemblyAI.
 *
 * Safe to re-run: existing resources are reused rather than duplicated, and
 * the generated session and push keys are written once and then left alone,
 * so a re-run doesn't sign you out or break push on subscribed devices.
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

// Anything that escapes the flow below lands here rather than as a raw stack
// trace. Child-process failures carry their real explanation on stderr, so
// surface that as the hint.
process.on('unhandledRejection', (e) => die(errMessage(e), errDetail(e)));
process.on('uncaughtException', (e) => die(errMessage(e), errDetail(e)));

const errMessage = (e) => String(e?.message || e);
const errDetail = (e) => {
  const out = `${e?.stderr ?? ''}${e?.stdout ?? ''}`.trim();
  return out ? out.split('\n').slice(-6).join('\n  ') : undefined;
};

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

// Use the wrangler pinned in worker/package-lock.json, not whatever `npx`
// would fetch. The version matters: `run_worker_first` as a list of routes —
// what lets one Worker serve both the API and the web app — is not in older
// releases. `npx` would also stop to ask permission before installing, which
// deadlocks the calls that pipe a secret in on stdin.
const wranglerBin = join(WORKER_DIR, 'node_modules', '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

function installWorkerDeps() {
  if (existsSync(wranglerBin)) return;
  sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: WORKER_DIR });
}

const wrangler = (args, opts = {}) => sh(wranglerBin, args, opts);

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

// Trust Hub lives on its own host, not under /Accounts/<sid>.
async function trustHub(path, sid, token) {
  const res = await fetch(`https://trusthub.twilio.com/v1${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
  });
  if (!res.ok) throw new Error(`Trust Hub ${res.status}`);
  return res.json();
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

async function choose(question, items, label) {
  if (items.length === 1) return items[0];
  console.log();
  items.forEach((item, i) => console.log(`    ${i + 1}) ${label(item)}`));
  const pick = await ask(question, {
    validate: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= items.length ? null : `Enter 1-${items.length}.`),
  });
  return items[+pick - 1];
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
const cfAccount = await choose('Which account', accounts.result, (a) => a.name);
const accountId = cfAccount.id;
ok(`account: ${cfAccount.name}`);

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

step('Installing deploy tooling');
installWorkerDeps();
ok(`wrangler ${wrangler(['--version'], { env }).trim().split(/\s+/).pop()}`);

step('Creating database and storage');

// The id is what the config actually needs, and the API is the authority on
// it. Parsing it out of wrangler's "add this to your config" snippet works
// today but is output formatting, not an interface — so it's the fallback.
const lookupD1 = async () => {
  const list = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(d1Name)}`, cfToken);
  return list.result?.find((d) => d.name === d1Name)?.uuid;
};

let d1Id;
let createOutput = '';
try {
  createOutput = wrangler(['d1', 'create', d1Name], { env });
  ok(`database created: ${d1Name}`);
} catch (e) {
  // Already exists from a previous run — reuse it rather than failing.
  info('database already existed, reusing it');
  createOutput = errDetail(e) ?? '';
}
d1Id = (await lookupD1()) ?? /database_id\s*=\s*"([^"]+)"/.exec(createOutput)?.[1];
if (!d1Id) {
  die(`Could not create or find the database "${d1Name}".`,
      'The API token needs a D1: Edit permission row.');
}

try {
  wrangler(['r2', 'bucket', 'create', r2Name], { env });
  ok(`storage created: ${r2Name}`);
} catch (e) {
  // execFileSync puts the explanation on stderr, not stdout.
  const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (output.includes('10042')) {
    die('R2 is not enabled on your Cloudflare account.',
        'Open dash.cloudflare.com → R2 Object Storage → enable it, then re-run this.');
  }
  if (!/already exists|10004/i.test(output)) {
    die(`Could not create the storage bucket "${r2Name}".`, errDetail(e));
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

// wrangler.toml is a tracked file, and in a repo that already has a running
// deployment it holds that deployment's database id. Overwriting it with a
// different Worker's config would orphan the old one, so keep a copy.
const configPath = join(WORKER_DIR, 'wrangler.toml');
if (existsSync(configPath)) {
  const previous = readFileSync(configPath, 'utf8');
  const previousName = /^name\s*=\s*"([^"]+)"/m.exec(previous)?.[1];
  if (previousName && previousName !== workerName) {
    writeFileSync(`${configPath}.bak`, previous);
    info(`existing config for "${previousName}" saved as wrangler.toml.bak`);
  }
}

writeFileSync(configPath, config);
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

// Which secrets already exist, so a re-run doesn't rotate the ones that would
// break a working install. Nothing exists yet on a first run, and the Worker
// itself may not exist either — both mean "none".
const existingSecrets = new Set();
{
  const res = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/secrets`, cfToken);
  for (const s of res.result ?? []) existingSecrets.add(s.name);
}

// Typed in this run, so always written: the user may be correcting them.
const entered = {
  TWILIO_ACCOUNT_SID: twSid,
  TWILIO_AUTH_TOKEN: twToken,
  TRANSCRIBE_API_KEY: aaiKey,
  OWNER_EMAIL: email,
  ...(resendKey ? { RESEND_API_KEY: resendKey } : {}),
};

// Generated, and only meaningful in their first form. Rotating SESSION_SECRET
// signs you out of every device; rotating the VAPID keys silently kills push
// on already-subscribed devices; SETUP_CODE stops matching the one you were
// shown. So these are written once and then left alone.
const generated = {
  SESSION_SECRET: sessionSecret,
  SETUP_CODE: setupCode,
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_PRIVATE_KEY: vapidPrivate,
};

let written = 0;
for (const [name, value] of Object.entries(entered)) {
  wrangler(['secret', 'put', name], { env, input: value });
  written++;
}
const setupCodeIsNew = !existingSecrets.has('SETUP_CODE');
for (const [name, value] of Object.entries(generated)) {
  if (existingSecrets.has(name)) continue;
  wrangler(['secret', 'put', name], { env, input: value });
  written++;
}
ok(`${written} secrets stored`);
if (existingSecrets.size) info('kept existing session and push keys so current sign-ins survive');

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
  // Twilio will not sell a number until a Trust Hub customer profile has been
  // approved, and approval is a human review that takes up to two business
  // days. Checking first turns a raw API error into a clear next step — and
  // everything above this point is already deployed and keeps working, so
  // this is a pause rather than a failure.
  let approved = true;
  try {
    const profiles = await trustHub('/CustomerProfiles?PageSize=20', twSid, twToken);
    approved = (profiles.results ?? []).some((p) => p.status === 'twilio-approved');
  } catch {
    // Can't tell — let the purchase attempt below be the judge.
  }

  if (!approved) {
    console.log(c.yellow('    ! Twilio has no approved customer profile yet, so no number can be bought.'));
    info('Create one:  node scripts/setup-twilio-profile.mjs   (see its header for the values it needs)');
    info('Approval usually lands within two business days. Re-run this installer afterwards —');
    info('everything else is already deployed, and the re-run only adds the number.');
  } else {
    const search = await twilio('/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=5', twSid, twToken);
    const pick = search.available_phone_numbers?.[0];
    if (!pick) die('No voice-capable numbers available on your Twilio account.');
    try {
      number = await twilio('/IncomingPhoneNumbers.json', twSid, twToken, {
        PhoneNumber: pick.phone_number,
        FriendlyName: 'Voicemail',
      });
      ok(`purchased ${number.phone_number}`);
    } catch (e) {
      const msg = errMessage(e);
      if (/insufficient|21404/i.test(msg)) {
        die('Twilio has insufficient funds to buy a number.',
            'Trial accounts must be upgraded first. Everything else is deployed — re-run afterwards.');
      }
      die(`Twilio would not sell a number: ${msg}`,
          'Everything else is deployed. Fix this in the console, then re-run.');
    }
  }
}

if (number) {
  await twilio(`/IncomingPhoneNumbers/${number.sid}.json`, twSid, twToken, {
    VoiceUrl: `${appOrigin}/twilio/voice`,
    VoiceMethod: 'POST',
  });
  ok('voice webhook attached');
}

/* ---- done ---- */

const forwarding = number
  ? `  ${c.bold('Then turn on call forwarding')} from your phone's dialer:
      ${c.bold(`**004*${number.phone_number.replace(/^\+1/, '')}#`)}      then press call

      Only calls you DON'T answer are forwarded. Outgoing calls
      and texts are unaffected. To undo it later: ##004#

  ${c.dim(`Your number: ${number.phone_number}`)}`
  : `  ${c.yellow('No phone number yet')} — see the Twilio note above. Re-run this
  installer once that clears and it will buy the number and print
  the call-forwarding code.`;

console.log(`
${c.green('━'.repeat(64))}
${c.bold(number ? '  Done.' : '  Deployed — one step left.')}

  ${c.bold('Open your app')}
      ${appOrigin}

  ${c.bold('Setup code')} — creates your account, used once
      ${c.bold(setupCodeIsNew ? setupCode : 'unchanged from your first run')}

${forwarding}

  ${c.dim('Save your recovery codes when the app shows them — they appear once.')}
${resendKey ? '' : `  ${c.dim('No Resend key, so emailed sign-in links are off: recovery codes are')}
  ${c.dim('your only way back in if you lose your passkey. Re-run to add one.')}`}
${c.green('━'.repeat(64))}
`);

rl.close();
