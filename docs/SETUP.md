# Setup

End to end this takes about 45 minutes. Do the steps in order — later ones need
values printed by earlier ones.

**What you'll need:** a Twilio account (~$1.15/mo), a free Cloudflare account,
an AssemblyAI key, and a Google account for Gmail notifications.

---

## 1. Twilio: get a number that answers your calls

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio) and verify your
   Mint number as a caller ID.
2. **Phone Numbers → Buy a number.** Pick any US local number with **Voice**
   capability. Area code doesn't matter — nobody dials this number directly.
3. From the Console dashboard, copy your **Account SID** and **Auth Token**.
   You'll need both in step 3.

Leave the webhook fields blank for now; you'll fill them in at step 4.

> **Cost:** $1.15/month for the number, $0.0085/min inbound. A typical personal
> line runs well under $2/month all in.

---

## 2. AssemblyAI: transcription

Get an API key at [assemblyai.com](https://www.assemblyai.com/app/account).

The Worker defaults to `universal-3-pro` with a `universal-2` fallback —
the same configuration proven out on real voicemail audio.

To use a different engine instead, set `TRANSCRIBE_PROVIDER` in
`worker/wrangler.toml` to `groq`, `deepgram`, `openai`, or `custom`.
See [TRANSCRIPTION.md](./TRANSCRIPTION.md).

---

## 3. Cloudflare: deploy the backend

```bash
cd worker
npm install
npx wrangler login
```

**Create the database and audio bucket:**

```bash
npx wrangler d1 create mint-voicemail
npx wrangler r2 bucket create mint-voicemail-audio
```

The `d1 create` command prints a `database_id`. Paste it into
`worker/wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_ID`.

**Create the tables:**

```bash
npm run db:init
```

**Generate your VAPID keys** (for web push) and a session secret:

```bash
node -e '
const { subtle } = require("crypto").webcrypto;
subtle.generateKey({name:"ECDSA",namedCurve:"P-256"}, true, ["sign","verify"]).then(async k => {
  const pub = Buffer.from(await subtle.exportKey("raw", k.publicKey));
  const jwk = await subtle.exportKey("jwk", k.privateKey);
  console.log("VAPID_PUBLIC_KEY :", pub.toString("base64url"));
  console.log("VAPID_PRIVATE_KEY:", jwk.d);
  console.log("SESSION_SECRET   :", require("crypto").randomBytes(32).toString("base64url"));
  console.log("SETUP_CODE       :", require("crypto").randomBytes(9).toString("base64url"));
});'
```

Save that output somewhere temporary — you need it in the next block and for
step 6.

**Set the secrets** (each command prompts for the value):

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID     # from step 1
npx wrangler secret put TWILIO_AUTH_TOKEN      # from step 1
npx wrangler secret put TRANSCRIBE_API_KEY     # from step 2
npx wrangler secret put OWNER_EMAIL            # your Gmail address
npx wrangler secret put SESSION_SECRET         # generated above
npx wrangler secret put SETUP_CODE             # generated above
npx wrangler secret put VAPID_PUBLIC_KEY       # generated above
npx wrangler secret put VAPID_PRIVATE_KEY      # generated above
```

**Deploy:**

```bash
npm run deploy
```

Copy the `https://mint-voicemail.<your-subdomain>.workers.dev` URL it prints.

---

## 4. Point Twilio at the Worker

Back in the Twilio Console, open your number's configuration:

| Field | Value |
|---|---|
| **A call comes in** → Webhook | `https://<your-worker>.workers.dev/twilio/voice` |
| Method | `HTTP POST` |

Save. Call the Twilio number directly from any phone — you should hear the
greeting and a beep. (Nothing appears in the app yet; you haven't built it.)

---

## 5. Gmail notifications via Apps Script

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the placeholder code, paste in all of `appsscript/Code.gs`, and save.
3. Run the `setup` function once (select it in the toolbar, click **Run**).
   Approve the permissions prompt — it needs Gmail send access.
   Google will warn the app is unverified; it's your own script, so choose
   **Advanced → Go to (project name)**.
4. Open **View → Logs** and copy the printed `GAS_SHARED_SECRET`.
5. **Deploy → New deployment → Web app:**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the resulting `/exec` URL.

> "Anyone" is required because Cloudflare calls it without a Google session.
> The shared secret is what actually authenticates the caller, and the Worker
> is the only thing that knows it. Treat the URL as a secret too.

Then wire it into the Worker:

```bash
cd worker
npx wrangler secret put GAS_WEBHOOK_URL    # the /exec URL
npx wrangler secret put GAS_SHARED_SECRET  # from the logs
npm run deploy
```

---

## 6. GitHub Pages: the web app

**Enable Pages:** repo **Settings → Pages → Source: GitHub Actions**.

**Add two repository variables** under
**Settings → Secrets and variables → Actions → Variables:**

| Name | Value |
|---|---|
| `VITE_API_BASE` | `https://mint-voicemail.<your-subdomain>.workers.dev` |
| `BASE_PATH` | `/Mint-Voicemail/` |

Push to `main` (or run the workflow manually) and the app deploys to
`https://<you>.github.io/Mint-Voicemail/`.

**Finally, tell the Worker where the app lives.** Edit `worker/wrangler.toml`:

```toml
APP_ORIGIN = "https://<you>.github.io"
RP_ID      = "<you>.github.io"
```

Then `npm run deploy` again. This matters: `APP_ORIGIN` is the CORS allowlist
and `RP_ID` is what passkeys are bound to. Wrong values mean sign-in fails.

---

## 7. Create your account

1. Open the app. It'll show **First-time setup**.
2. Enter the `SETUP_CODE` from step 3.
3. Create a passkey (Face ID / Touch ID / Windows Hello / security key).
4. **Save the ten recovery codes.** They're shown once and never again —
   the server only keeps hashes. Download or print them.

Enrollment locks itself the moment that first passkey exists. From then on,
adding a device requires already being signed in.

Now go to **Settings** and:
- **Enable push** on each device you want alerts on.
- **Add a second passkey** on another device. One passkey is a single point of
  failure; two is not.

---

## 8. Turn on call forwarding

This is the step that connects your Mint line. On your phone's dialer:

| Purpose | Code |
|---|---|
| **Forward when busy** | `*90<TwilioNumber>#` |
| **Forward when unanswered** | `*92<TwilioNumber>#` |
| **Forward when unreachable** | `*94<TwilioNumber>#` |
| **All three at once** | `**004*<TwilioNumber>#` |
| **Turn everything off** | `##004#` |

Use the 10-digit number with no punctuation — e.g. `**004*5551234567#`, then
press call. You'll get a brief confirmation from the network.

**Test it:** have someone call your Mint number and let it ring out. Within a
minute you should get a push notification and a Gmail, and the voicemail should
appear in the app with a transcript.

To undo everything and go back to Mint's own voicemail, dial `##004#`.

> Your outgoing calls, texts, and answered calls are completely unaffected.
> This only redirects calls you *don't* answer.

---

## Troubleshooting

**Caller hears an error instead of the greeting.**
Check `npx wrangler tail` while calling. Almost always `APP_ORIGIN`/webhook URL
typos, or the Worker wasn't redeployed after a secret change.

**Voicemails appear but transcripts say "failed".**
`npx wrangler tail` and look for `transcribe_failed`. Usually an invalid or
rate-limited `TRANSCRIBE_API_KEY`. Fix it, then hit **Retry transcript** in the
app — the audio is safe in R2, so nothing is lost.

**Sign-in fails with "Passkey registration failed".**
`RP_ID` must exactly match the app's hostname, with no scheme, port, or path.
For `https://you.github.io/Mint-Voicemail/` that's `you.github.io`.

**No Gmail arriving.**
Test Apps Script directly:
```bash
curl -X POST "<your /exec URL>" -H 'Content-Type: text/plain' \
  -d '{"kind":"test","secret":"<GAS_SHARED_SECRET>"}'
```
If that sends mail, the script is fine and the Worker's secrets are wrong.

**Push works on desktop but not iPhone.**
iOS only delivers web push to apps added to the Home Screen. Open the app in
Safari → Share → **Add to Home Screen**, then enable push from *that* icon.

**Locked out entirely.**
Use a recovery code, or the magic link. If both are gone, you still have
console access: `npx wrangler d1 execute mint-voicemail --remote --command
"DELETE FROM credentials"` resets enrollment so your `SETUP_CODE` works again.
Your voicemails are untouched.
