// Pluggable speech-to-text.
//
// Every provider is a function (env, audioBuffer) -> { text, confidence, provider }.
// Selecting one is a single env var (TRANSCRIBE_PROVIDER), so swapping engines
// never touches the calling code.
//
// To plug in your own service (e.g. the Python transcriber you already have),
// set TRANSCRIBE_PROVIDER=custom and TRANSCRIBE_URL to its endpoint. It will be
// sent a POST with the raw MP3 body and should reply with JSON containing a
// "text" field. Anything shaped like {"text": "..."} works. If yours expects a
// different shape, `custom` below is the only function you need to edit.

const PROVIDERS = {
  /**
   * AssemblyAI — the default, mirroring the settings already proven out on
   * real voicemail: universal-3-pro with a universal-2 fallback, punctuation
   * and text formatting on.
   *
   * The SDK's `speech_models` fallback list is a client-side convenience; the
   * REST API takes a single `speech_model`, so the fallback is done explicitly
   * here. Workers can't use the Python SDK, so this is the raw three-step API:
   * upload -> request transcript -> poll.
   */
  async assemblyai(env, audio) {
    const key = env.TRANSCRIBE_API_KEY;
    if (!key) throw new Error('TRANSCRIBE_API_KEY is not set');

    // 1. Upload the audio; AssemblyAI returns a private URL to reference.
    const upload = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: key, 'Content-Type': 'application/octet-stream' },
      body: audio,
    });
    if (!upload.ok) throw new Error(`assemblyai upload ${upload.status}: ${await upload.text()}`);
    const { upload_url: audioUrl } = await upload.json();

    // 2. Request transcription, walking the model list on failure.
    const models = (env.TRANSCRIBE_MODEL || 'universal-3-pro,universal-2')
      .split(',').map((m) => m.trim()).filter(Boolean);

    let lastError;
    for (const model of models) {
      try {
        return await requestAssemblyAiTranscript(key, audioUrl, model, env);
      } catch (e) {
        lastError = e;
        // Fall through to the next model. A model can be unavailable or
        // rejected for this account without the audio being at fault.
      }
    }
    throw lastError ?? new Error('assemblyai: no models configured');
  },

  /**
   * Groq — hosted Whisper large-v3-turbo. Free tier is generous, latency is
   * ~1s for a minute of audio, and it handles 8kHz phone audio well.
   */
  async groq(env, audio) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voicemail.mp3');
    form.append('model', env.TRANSCRIBE_MODEL || 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('language', env.TRANSCRIBE_LANGUAGE || 'en');
    // Priming the decoder with context measurably improves proper nouns
    // and phone numbers, which is most of what voicemail actually contains.
    form.append('prompt', 'A voicemail message. May include names, phone numbers, and callback details.');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TRANSCRIBE_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return {
      text: (data.text || '').trim(),
      // Whisper reports avg_logprob per segment; fold it into a rough 0-1.
      confidence: avgLogprobToConfidence(data.segments),
      provider: 'groq',
    };
  },

  /** Deepgram Nova — cheapest per minute, strong on noisy telephony audio. */
  async deepgram(env, audio) {
    const qs = new URLSearchParams({
      model: env.TRANSCRIBE_MODEL || 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      numerals: 'true', // "five five five" -> "555"
    });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.TRANSCRIBE_API_KEY}`,
        'Content-Type': 'audio/mpeg',
      },
      body: audio,
    });
    if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: (alt?.transcript || '').trim(),
      confidence: alt?.confidence ?? null,
      provider: 'deepgram',
    };
  },

  /** OpenAI Whisper / gpt-4o-transcribe. */
  async openai(env, audio) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voicemail.mp3');
    form.append('model', env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
    form.append('response_format', 'json');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TRANSCRIBE_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return { text: (data.text || '').trim(), confidence: null, provider: 'openai' };
  },

  /**
   * Bring-your-own endpoint. Set TRANSCRIBE_URL; optionally TRANSCRIBE_API_KEY
   * (sent as a Bearer token). Accepts several common response shapes so most
   * self-hosted Whisper wrappers work without modification.
   */
  async custom(env, audio) {
    if (!env.TRANSCRIBE_URL) throw new Error('TRANSCRIBE_URL is not set');

    const headers = { 'Content-Type': 'audio/mpeg' };
    if (env.TRANSCRIBE_API_KEY) headers.Authorization = `Bearer ${env.TRANSCRIBE_API_KEY}`;

    const res = await fetch(env.TRANSCRIBE_URL, { method: 'POST', headers, body: audio });
    if (!res.ok) throw new Error(`custom ${res.status}: ${await res.text()}`);

    const ct = res.headers.get('Content-Type') || '';
    if (!ct.includes('json')) {
      return { text: (await res.text()).trim(), confidence: null, provider: 'custom' };
    }

    const data = await res.json();
    const text = data.text ?? data.transcript ?? data.transcription ?? data.result ?? '';
    return {
      text: String(text).trim(),
      confidence: data.confidence ?? null,
      provider: 'custom',
    };
  },
};

/**
 * Submit one transcription job and poll to completion.
 *
 * Polling (rather than AssemblyAI's webhook) keeps ingestion in a single code
 * path. Voicemails are short, so this settles in a few seconds; the cap exists
 * so a stuck job can't hold the request open forever. On timeout the voicemail
 * stays 'pending' and the app's "Retry transcript" button re-runs it.
 */
async function requestAssemblyAiTranscript(key, audioUrl, model, env) {
  const create = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_model: model,
      punctuate: true,
      format_text: true,
      language_code: env.TRANSCRIBE_LANGUAGE || 'en_us',
    }),
  });
  if (!create.ok) throw new Error(`assemblyai create ${create.status}: ${await create.text()}`);

  const { id } = await create.json();
  const deadline = Date.now() + 90_000;
  let delay = 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000); // back off, but stay responsive

    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: key },
    });
    if (!poll.ok) throw new Error(`assemblyai poll ${poll.status}`);

    const data = await poll.json();
    if (data.status === 'completed') {
      return {
        text: (data.text || '').trim(),
        confidence: data.confidence ?? null,
        provider: `assemblyai/${model}`,
      };
    }
    if (data.status === 'error') throw new Error(`assemblyai: ${data.error}`);
  }

  throw new Error('assemblyai: timed out waiting for transcript');
}

export async function transcribe(env, audio) {
  const name = (env.TRANSCRIBE_PROVIDER || 'assemblyai').toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown TRANSCRIBE_PROVIDER: ${name}`);

  const result = await provider(env, audio);
  if (!result.text) result.text = '(no speech detected)';
  return result;
}

export const availableProviders = Object.keys(PROVIDERS);

function avgLogprobToConfidence(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const sum = segments.reduce((acc, s) => acc + (s.avg_logprob ?? 0), 0);
  // avg_logprob is roughly [-1, 0] for confident speech.
  return Math.max(0, Math.min(1, 1 + sum / segments.length));
}
