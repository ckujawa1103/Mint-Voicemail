#!/usr/bin/env node
/**
 * Creates and submits a Twilio Trust Hub **Starter Profile** via the API.
 *
 * Twilio requires an approved compliance profile before you can buy a number.
 * The console pushes you toward the *business* profile, which asks for
 * business title and job position. Individuals don't need that one — the
 * Starter Profile takes only your name, email, and phone, and that is what
 * this creates. It also sidesteps the console's broken job-position dropdown
 * entirely, because the field isn't part of this flow.
 *
 * Run it yourself so your credentials never leave your machine:
 *
 *   TWILIO_ACCOUNT_SID=ACxxxx \
 *   TWILIO_AUTH_TOKEN=xxxx \
 *   FIRST_NAME=Christopher \
 *   LAST_NAME=Kujawa \
 *   EMAIL=you@gmail.com \
 *   PHONE=+16315551234 \
 *   node scripts/setup-twilio-profile.mjs
 *
 * Address is optional but strongly recommended — evaluation usually requires
 * one. Supply all four to include it:
 *
 *   STREET="123 Main St" CITY="Ottawa" REGION="IL" POSTAL_CODE="61350"
 *
 * Optional:
 *   DRY_RUN=1   show what would be sent, create nothing
 *
 * Approval typically lands within two business days. Once approved, run
 * scripts/setup-twilio.mjs to buy the number.
 */

const {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  FIRST_NAME, LAST_NAME, EMAIL, PHONE,
  STREET, CITY, REGION, POSTAL_CODE,
} = process.env;

const DRY_RUN = process.env.DRY_RUN === '1';

// Twilio's fixed policy SID for Starter Profiles.
const STARTER_POLICY_SID = 'RN806dd6cd175f314e1f96a9727ee271f4';

const TRUSTHUB = 'https://trusthub.twilio.com/v1';
const auth = () => 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

for (const [name, value] of Object.entries({
  TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN,
  FIRST_NAME, LAST_NAME, EMAIL, PHONE,
})) {
  if (!value) die(`Set ${name}.`);
}

if (!/^\+1\d{10}$/.test(PHONE)) {
  die('PHONE must be E.164 format, e.g. +16315551234 (with the +1).');
}

const hasAddress = STREET && CITY && REGION && POSTAL_CODE;

async function post(url, form) {
  if (DRY_RUN) {
    console.log(`  [dry run] POST ${url}`);
    for (const [k, v] of Object.entries(form)) console.log(`      ${k}=${v}`);
    return { sid: 'DRYRUNSID', status: 'draft' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log(`\nCreating Twilio Starter Profile for ${FIRST_NAME} ${LAST_NAME}\n`);

  // 1. The profile bundle itself.
  const profile = await post(`${TRUSTHUB}/CustomerProfiles`, {
    FriendlyName: `${FIRST_NAME} ${LAST_NAME} — Personal Voicemail`,
    Email: EMAIL,
    PolicySid: STARTER_POLICY_SID,
  });
  console.log(`✓ Profile created: ${profile.sid}`);

  // 2. Who you are. Note: no business_title, no job_position.
  const endUser = await post(`${TRUSTHUB}/EndUsers`, {
    FriendlyName: `${FIRST_NAME} ${LAST_NAME}`,
    Type: 'starter_customer_profile_information',
    Attributes: JSON.stringify({
      first_name: FIRST_NAME,
      last_name: LAST_NAME,
      email: EMAIL,
      phone_number: PHONE,
    }),
  });
  console.log(`✓ End user created: ${endUser.sid}`);

  await post(`${TRUSTHUB}/CustomerProfiles/${profile.sid}/EntityAssignments`, {
    ObjectSid: endUser.sid,
  });
  console.log('✓ End user attached to profile');

  // 3. Address, if supplied. Evaluation usually fails without one.
  if (hasAddress) {
    const address = await post(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Addresses.json`,
      {
        CustomerName: `${FIRST_NAME} ${LAST_NAME}`,
        Street: STREET,
        City: CITY,
        Region: REGION,
        PostalCode: POSTAL_CODE,
        IsoCountry: 'US',
      },
    );
    console.log(`✓ Address created: ${address.sid}`);

    const doc = await post(`${TRUSTHUB}/SupportingDocuments`, {
      FriendlyName: 'Home address',
      Type: 'customer_profile_address',
      Attributes: JSON.stringify({ address_sids: address.sid }),
    });
    console.log(`✓ Address document created: ${doc.sid}`);

    await post(`${TRUSTHUB}/CustomerProfiles/${profile.sid}/EntityAssignments`, {
      ObjectSid: doc.sid,
    });
    console.log('✓ Address attached to profile');
  } else {
    console.log('\n! No address supplied (STREET/CITY/REGION/POSTAL_CODE).');
    console.log('  Evaluation will likely flag this. Re-run with them if it does.\n');
  }

  if (DRY_RUN) {
    console.log('\nDRY_RUN set — nothing was actually created.\n');
    return;
  }

  // 4. Ask Twilio whether the bundle satisfies the policy, before submitting.
  const evaluation = await post(
    `${TRUSTHUB}/CustomerProfiles/${profile.sid}/Evaluations`,
    { PolicySid: STARTER_POLICY_SID },
  );

  if (evaluation.status !== 'compliant') {
    console.log(`\n✗ Evaluation: ${evaluation.status}. Unmet requirements:\n`);
    for (const result of evaluation.results || []) {
      for (const field of result.fields || []) {
        if (field.passed === false) {
          console.log(`   - ${result.friendly_name || result.object_type}: ${field.friendly_name}`);
        }
      }
    }
    console.log(`\nProfile ${profile.sid} is saved as a draft. Fix the above and`);
    console.log('finish it in the console under Trust Hub, or re-run with more details.\n');
    return;
  }

  console.log('✓ Evaluation: compliant');

  // 5. Submit for review.
  const submitted = await post(`${TRUSTHUB}/CustomerProfiles/${profile.sid}`, {
    Status: 'pending-review',
  });

  console.log(`
─────────────────────────────────────────────
  ✓ Submitted for review — status: ${submitted.status}

  Profile SID: ${profile.sid}

  Approval usually lands within two business
  days. You'll get an email.

  Once approved:
      node scripts/setup-twilio.mjs
─────────────────────────────────────────────
`);
}

main().catch((e) => {
  const msg = String(e.message);
  if (msg.includes('20003')) die('Authentication failed. Check your SID and auth token.');
  if (msg.includes('already exists')) {
    die('A profile like this already exists. Check Trust Hub in the console.');
  }
  die(msg);
});
