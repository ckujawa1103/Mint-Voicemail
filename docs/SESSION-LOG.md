# Build log — from empty repo to working system

A record of how this was built, what broke, and why things are the way they
are. Written so a future session (or a future you) can pick up without
re-deriving anything.

> **Redaction notice.** The original conversation contained live API tokens
> (Twilio, Cloudflare, AssemblyAI, Resend), the account setup code, and personal
> details (home address, date of birth, phone numbers). This repository is
> public, so none of that is reproduced here. Every secret lives in Cloudflare
> Workers secrets and nowhere else — not in this repo, not in this file.
> Referenced below only by variable name.

---

## The original ask

> "I have Mint Mobile and would like a way to have my voicemail transcribed and
> managed without me navigating through a call menu. Build me a web app I can
> host on GitHub that lets me read, listen, save, and delete voicemail, and
> emails or texts me when new ones come in. Make sure there's adequate security
> so I'm the only one with access, with failsafes in case I forget my password."

## The central constraint

**Mint Mobile has no voicemail API, and never will.** Mint is an MVNO on
T-Mobile's network; its "visual voicemail" is whatever the handset's dialer does
locally. There is nothing to integrate with server-side.

The only reliable integration point is **conditional call forwarding**. Dialing
`**004*<number>#` once tells the network to hand any *unanswered* call to a
number you control instead of the carrier's voicemail. Answered calls, outgoing
calls, and texts are untouched. `##004#` reverses it completely. It's free on
Mint.

Everything else follows from that: forward to a Twilio number, own the rest.

```
caller → Mint line ──(unanswered)──► Twilio ──► Cloudflare Worker
                                                  ├─ audio ──► R2
                                                  ├─ metadata ──► D1
                                                  ├─ AssemblyAI ──► transcript
                                                  ├─ Web Push ──► phone
                                                  └─ Resend ──► email
```

---

## Decisions and why

**Cloudflare Workers for the backend.** GitHub Pages is static-only and can't
receive Twilio's webhooks. Workers' free tier (100k req/day, 5GB D1, 10GB R2
with no egress fees) is far beyond personal voicemail volume. Supabase was
rejected because its free tier pauses projects after inactivity — fatal for
something that must answer a phone call at any moment.

**AssemblyAI for transcription**, `universal-3-5-pro` with a `universal-2`
fallback, punctuation and formatting on. This mirrors a configuration already
proven on real voicemail audio in a prior project. Groq, Deepgram, OpenAI, and a
bring-your-own-endpoint adapter are all implemented behind the same interface —
switching is one environment variable.

**Apps Script was chosen for Gmail, then dropped.** It sends from the user's own
Gmail, so transcripts never touch a third party — genuinely the better design.
It was abandoned because deploying it requires a browser OAuth consent flow that
cannot be automated or delegated. Resend replaced it: an API key, no consent
screen. Apps Script code remains in `appsscript/` and takes precedence
automatically if ever configured.

**Passkeys as the primary factor.** The ask was "failsafes in case I forget my
password." The strongest answer is having no password at all. Two independent
recovery paths back it: a magic link to the owner address, and ten single-use
PBKDF2-hashed recovery codes. Critically, both failsafes grant *both* a session
and the right to enroll a replacement passkey — that's the difference between an
inconvenience and a permanent lockout.

**Bearer tokens rather than cookies.** The app (github.io) and API
(workers.dev) were cross-site, and Safari blocks third-party cookies outright,
which would break sign-in on iPhone. Mitigated with a strict CSP and no
third-party scripts. *The installer branch makes this moot by serving the app
from the Worker on one origin.*

---

## Bugs found, and what they teach

### PBKDF2 iteration cap (serious — silent failure)

`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
supported (requested 210000)`

Cloudflare Workers hard-caps PBKDF2 at 100k iterations. The code used OWASP's
recommended 210k. `issueRecoveryCodes` threw mid-request — *after* passkey
enrollment had already committed. Sign-in worked, so nothing looked wrong. The
account simply had **no recovery codes at all**, and nobody would have
discovered that until they were locked out.

Fixed at 100k, which is ample here: the codes carry ~60 bits of entropy, so
stretching is defence-in-depth against a database leak, not the barrier to
guessing.

**Lesson, now encoded as a test:** Node has no such cap, so this class of bug
passes locally and fails only in production. The test reads the constant from
source rather than exercising the KDF.

### AssemblyAI `speech_model` deprecated

`speech_model` (singular) is deprecated in favour of `speech_models` — an
ordered fallback list the service walks itself. The original Python config used
the plural form; that was assumed to be an SDK convenience and a manual retry
loop was hand-rolled around a singular parameter. It was wrong, and the original
config was right. Model name is `universal-3-5-pro`, not `universal-3-pro`.
`language_code` is now left unset, since the universal models auto-detect and
pinning can conflict.

### Links dropped the GitHub Pages subdirectory

Magic links and push URLs were built from `APP_ORIGIN`, but Pages serves the app
under `/<repo>/`. CORS and WebAuthn both *require* the bare origin, so this
needed a separate `APP_BASE_URL` rather than changing the existing value.

### Test vectors written from memory were wrong

Two crypto test constants were recalled rather than looked up, and both were
wrong. The RFC 8291 record had 38 ciphertext bytes where 41 plaintext + 1
delimiter + 16 GCM tag = 58 — the implementation's longer output was correct all
along. Both were replaced with real cross-checks: Twilio signatures against an
independent Node-crypto HMAC, and push encryption round-tripped through an
independent RFC 8291 receiver.

**Remaining limit, stated honestly:** the round trip wouldn't catch a
*symmetric* misreading of the KDF info strings. Live push delivery is the
confirmation, and it works.

---

## Setup traps encountered (all real, all cost time)

| Trap | Symptom | Fix |
|---|---|---|
| Twilio Trust Hub is mandatory | Can't buy a number | Starter Profile via API; the console pushes you to the *business* profile which demands job position, but individuals need `individual_customer_profile_information` — no job field at all |
| Trust Hub submit is API-blocked | `This operation is restricted via API for Primary Customer Profiles` | Everything else scriptable; final submit must be a console click |
| GitHub Pages needs a paid plan for private repos | — | Repo must stay public; the deployed site is public regardless |
| Pages environment branch rule | Deploy job fails in 2s, **no logs, no runner** | `github-pages` environment pins its allowed branch to whatever was default when created; changing the default branch later does *not* update it |
| Actions workflow permissions read-only | Same silent instant failure | Settings → Actions → General → Read and write |
| `wrangler r2 object` defaults to local | Silently produced a 0-byte file | Always pass `--remote` |
| R2 needs manual enabling | `code: 10042` | One click in the dashboard; not API-enableable |

The Pages ones are worth emphasising: a job rejected by an environment rule
produces **no logs at all**, because no runner is ever assigned. The only place
the reason appears is the run's Annotations in the web UI.

---

## Current live state

- Twilio number forwards unanswered calls; voice webhook verified
- Worker deployed with D1, R2, and 9 secrets
- Web app on GitHub Pages
- Recorded greeting (recorded by calling the number, so it's already 8kHz mono
  MP3 — no conversion needed) served from R2 via `<Play>`
- AssemblyAI transcription working, ~98% confidence observed
- Web push working; Resend handles magic links and emailed transcripts
- One passkey, ten recovery codes, magic link verified end to end
- In-app modals replaced all native `confirm`/`prompt`/`alert`
- Call back / text back buttons via `tel:` and `sms:`

Verified against the live system: valid Twilio signatures accepted, forged and
unsigned both 403; greeting endpoint byte-identical to source; TwiML emits
`<Play>`; magic link delivered and used to sign in; address enumeration returns
byte-identical responses for owner and non-owner.

## Open items

**`claude/one-command-installer`** — unmerged, untested. Adds `npm run setup`
(provisions everything in ~2 minutes) and, more importantly, serves the web app
*from the Worker* on a single origin. That change alone removes GitHub Pages,
CORS, the WebAuthn RP-ID mismatch, and the Pages environment rules from setup —
four of the worst traps in the table above. **Needs testing against a clean
Cloudflare and Twilio account before merging.**

Optional, never done: a second passkey (currently one, so a lost phone means
falling back to recovery codes), and Apps Script for third-party-free emailed
transcripts.

## Commercialisation, briefly

Explored and left undecided. The finding worth keeping: onboarding was painful
because it *provisioned infrastructure*, which a product does once rather than
per customer. Marginal cost is ~$1.30/user/month, dominated by the $1.15 Twilio
number rental — a floor that can't be engineered away, so there's no free tier
that doesn't lose money. Google Voice does something similar for free, so the
wedge would be quality and maintenance, not capability. Selling pre-revenue code
fetches very little; buyers pay for cash flow.
