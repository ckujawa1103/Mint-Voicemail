# Mint Voicemail

Your Mint Mobile voicemail as a searchable inbox — read, listen, save, delete —
with transcripts pushed to your phone and your Gmail. No dial-in menu, no
"press 7 to delete."

Runs on free tiers plus a ~$1.15/month phone number.

---

## Why it works this way

**Mint has no voicemail API.** Mint is an MVNO on T-Mobile's network, and its
"visual voicemail" is whatever your phone's dialer does locally — there is
nothing to integrate with server-side.

The seam that *does* exist is **conditional call forwarding**. Dialing
`**004*<number>#` once tells the network to hand any call you don't answer to a
number you control, instead of Mint's voicemail. Answered calls, outgoing
calls, and texts are untouched, it's free on Mint, and `##004#` reverses it
completely.

So the design is: forward unanswered calls to a Twilio number, and own
everything downstream.

```
  caller
    │
    ▼
  your Mint line ──(unanswered)──► Twilio number
                                      │  records audio
                                      ▼
                              Cloudflare Worker
                                 │      │      │
              audio ──► R2       │      │      └──► AssemblyAI ──► transcript
              metadata ──► D1 ◄──┘      │
                                        ├──► Web Push ──► your phone
                                        └──► Apps Script ──► your Gmail
                                      │
  GitHub Pages (React app) ◄──────────┘
```

## What you get

- **Inbox** with search across every transcript and caller
- **Listen** to any message, scrub, download the MP3
- **Save** messages so they're never auto-purged
- **Delete** to a 30-day trash you can restore from
- **Notifications** by web push and Gmail, with the transcript in the body
- **Passkey sign-in** — no password to forget, and two independent failsafes

## Security

Single-user by construction. There is no registration, no user table, no
"forgot password" form to attack.

| | |
|---|---|
| **Sign-in** | WebAuthn passkey — Face ID, Touch ID, Windows Hello, security key |
| **Failsafe 1** | Magic link, only ever to `OWNER_EMAIL`, single-use, 15 min |
| **Failsafe 2** | Ten single-use recovery codes, stored as PBKDF2 hashes (210k iterations) |
| **Enrollment** | Locks the instant the first passkey exists; adding a device requires being signed in |
| **Webhooks** | Every Twilio request verified by HMAC-SHA1 signature |
| **Audio** | Served via short-lived HMAC tokens scoped to one message |
| **Rate limits** | On every auth path — 3/hour for magic links, 5/hour for recovery codes |
| **Audit log** | Every sign-in and rejected attempt, visible in Settings |
| **Sessions** | Revocable individually or all at once |

Twilio's copy of each recording is deleted once it's safely in R2, so your
voicemail lives in exactly one place you control.

**Losing your phone is recoverable.** The failsafes grant a session *and* the
right to enroll a fresh passkey — that's the difference between an
inconvenience and a lockout. The app nags you to register a second device for
exactly this reason, and `docs/SETUP.md` documents a console-level reset as the
last resort.

## Setup

**[→ docs/SETUP.md](docs/SETUP.md)** — about 45 minutes, in order.

You'll need a Twilio account, a free Cloudflare account, an AssemblyAI key, and
a Google account.

## Layout

```
worker/       Cloudflare Worker — Twilio webhooks, auth, API
  src/
    index.js       router
    twilio.js      call handling, signature verification, ingestion
    transcribe.js  pluggable speech-to-text
    auth.js        passkeys, magic links, recovery codes, sessions
    notify.js      web push (RFC 8291) + Gmail bridge
    api.js         voicemail CRUD, audio streaming
  test/       crypto tests — run with `npm test`
web/          React app → GitHub Pages
appsscript/   Google Apps Script — sends Gmail as you
docs/         Setup and transcription guides
```

## Running costs

| | |
|---|---|
| Twilio number | $1.15/month |
| Twilio inbound | $0.0085/min |
| AssemblyAI | ~$0.0062/min |
| Cloudflare Workers, D1, R2 | $0 (free tier) |
| GitHub Pages | $0 |
| Gmail via Apps Script | $0 |

Around **$2/month** for typical personal use.

## Development

```bash
cd worker && npm install && npm test    # crypto tests
cd worker && npm run dev                # local Worker
cd web    && npm install && npm run dev # local app
```

## Swapping transcription engines

One env var. AssemblyAI, Groq, Deepgram, OpenAI, or your own endpoint —
see [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md).
