# Transcription providers

Every provider is one function with the same shape, selected by the
`TRANSCRIBE_PROVIDER` variable in `worker/wrangler.toml`. Switching engines
never touches the ingestion code.

```js
async provider(env, audioBuffer) -> { text, confidence, provider }
```

They all live in [`worker/src/transcribe.js`](../worker/src/transcribe.js).

## Built-in options

| Provider | `TRANSCRIBE_PROVIDER` | Cost | Notes |
|---|---|---|---|
| **AssemblyAI** | `assemblyai` | ~$0.0062/min | **Default.** `universal-3-pro` with `universal-2` fallback |
| Groq (Whisper) | `groq` | Free tier | Whisper large-v3-turbo, very fast |
| Deepgram | `deepgram` | ~$0.0043/min | Nova-3, strong on noisy telephony |
| OpenAI | `openai` | ~$0.006/min | `gpt-4o-mini-transcribe` |
| Your own | `custom` | — | Any HTTP endpoint, see below |

Set the key with `npx wrangler secret put TRANSCRIBE_API_KEY` and redeploy.

## AssemblyAI specifics

`TRANSCRIBE_MODEL` is a comma-separated fallback list, tried left to right:

```toml
TRANSCRIBE_MODEL = "universal-3-pro,universal-2"
```

If a model is unavailable or rejected for your account, the next one runs.
This mirrors the SDK's `speech_models=[...]` behaviour — the REST API only
accepts a single `speech_model`, so the fallback is handled explicitly.

`punctuate` and `format_text` are always on, which is what makes transcripts
readable rather than a wall of lowercase.

The Worker uploads audio, requests a transcript, and polls for up to 90
seconds. Voicemails settle in a few seconds. If a job ever exceeds that, the
voicemail stays `pending` and **Retry transcript** in the app re-runs it — the
audio is already safe in R2, so a transcription failure never loses a message.

## Using your own endpoint

```toml
TRANSCRIBE_PROVIDER = "custom"
TRANSCRIBE_URL = "https://your-service.example.com/transcribe"
```

The Worker sends `POST` with the raw MP3 as the body and
`Content-Type: audio/mpeg`. If `TRANSCRIBE_API_KEY` is set it goes along as
`Authorization: Bearer <key>`.

Reply with JSON. Any of these keys are accepted:

```json
{ "text": "the transcript" }
{ "transcript": "..." }
{ "transcription": "..." }
{ "result": "..." }
```

A plain-text response body works too. Include `"confidence": 0.0–1.0` if you
have it — the app flags anything below 0.6 as worth listening to.

If your service needs a different request shape, `custom` in
`transcribe.js` is the only function to change.

## Adding a provider

Add a key to the `PROVIDERS` object:

```js
async myprovider(env, audio) {
  const res = await fetch('https://api.example.com/v1/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TRANSCRIBE_API_KEY}` },
    body: audio,
  });
  if (!res.ok) throw new Error(`myprovider ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return { text: data.text.trim(), confidence: data.confidence, provider: 'myprovider' };
}
```

Then set `TRANSCRIBE_PROVIDER = "myprovider"`. Throwing on failure is correct —
the caller records the failure and leaves the audio intact for a retry.
