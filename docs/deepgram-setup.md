# Deepgram setup (STT + TTS)

One Deepgram key can power both:
- **STT:** Nova (`nova-3`) on your push-to-talk WAV
- **TTS:** Flux (`flux-marcelo-en` by default) via **WebSocket streaming** `/v2/speak` (REST batch remains the fallback)

Streaming vs REST is the same Deepgram usage billing for the same spoken text — there is no separate WebSocket fee. Streaming mainly cuts **time-to-first-audio** (batch REST waits for a full MP3).

## 1. Get an API key
1. https://console.deepgram.com/ → create a project
2. Create an API key
3. Copy it

## 2. Configure `.env`
In `making-jarvis` repo root:

```powershell
copy .env.example .env
notepad .env
```

```env
DEEPGRAM_API_KEY=your-key-here
VOICE_CURSOR_STT=auto
VOICE_CURSOR_TTS=auto
VOICE_CURSOR_TTS_VOICE=flux-marcelo-en
VOICE_CURSOR_TTS_RATE=1.1
# Flux streaming is on by default for flux-* voices (set off to force REST mp3)
# VOICE_CURSOR_TTS_STREAM=auto
```

Flux streaming connects to:
`wss://api.deepgram.com/v2/speak?model=flux-marcelo-en&encoding=linear16&sample_rate=24000`
(speed via `Configure`, default `1.1`)

REST fallback (Aura, or if WS fails):
`https://api.deepgram.com/v2/speak?model=flux-marcelo-en&speed=1.1`

With `auto`, Deepgram is preferred when the key is present (Whisper/Edge remain fallbacks).

## 3. Restart service
```powershell
git pull
npm run build
npm run service
```

Health check should show:
```json
"stt": { "resolved": "deepgram", "hasDeepgram": true }
"tts": { "resolved": "deepgram", "voice": "flux-marcelo-en", "stream": true, "hasDeepgram": true }
```

Service logs for a spoken reply should include `deepgram-tts-ws pcm-stream` and a low `firstAudioMs` (waveOut starts after ~100ms preroll — gapless, not choppy 120ms MCI clips or full-sentence waits).

## Voices / speed
- Flux models use `/v2/speak` (`flux-…`) — **WebSocket streaming by default**
- Aura models still use `/v1/speak` REST (`aura-…`)
- Flux speed must be one of: `0.85`, `0.9`, `0.95`, `1.0`, `1.05`, `1.1`, `1.15`
- Voice catalog: https://developers.deepgram.com/docs/flux-tts/voices
- Force REST: `VOICE_CURSOR_TTS_STREAM=off`
