# Deepgram setup (STT + TTS)

One Deepgram key can power both:
- **STT:** Flux listen (`flux-general-en` on `/v2/listen`) for pause-to-send, with Nova (`nova-3`) on WAV as fallback
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

# Flux voice configs (TTS /v2/speak)
VOICE_CURSOR_TTS_VOICE=flux-marcelo-en
VOICE_CURSOR_TTS_RATE=1.1
VOICE_CURSOR_TTS_EXPRESSIVITY=0
# VOICE_CURSOR_TTS_STREAM=auto
```

Flux streaming connects to:
`wss://api.deepgram.com/v2/speak?model=flux-marcelo-en&encoding=linear16&sample_rate=24000&expressivity=0`
(speed via `Configure`, default `1.1`)

REST fallback (Aura, or if WS fails):
`https://api.deepgram.com/v2/speak?model=flux-marcelo-en&speed=1.1&expressivity=0`

With `auto`, Deepgram is preferred when the key is present. Live listen uses Flux `/v2/listen` (`EndOfTurn` auto-sends). OpenAI Whisper and Windows STT remain **fallbacks** for the WAV path (not the primary path). Edge/SAPI remain TTS fallbacks. See [openai-whisper-setup.md](openai-whisper-setup.md) if you need the Whisper fallback.

Pause-to-send tuning (optional):

```env
# VOICE_CURSOR_EOT_THRESHOLD=0.7
# VOICE_CURSOR_EOT_TIMEOUT_MS=7000
# VOICE_CURSOR_VAD=0   # force click-to-send WAV PTT
```

## 3. Restart service
```powershell
git pull
npm run build
npm run service
```

Health check should show:
```json
"stt": { "resolved": "deepgram", "hasDeepgram": true, "vad": true, "streamListen": true }
"tts": { "resolved": "deepgram", "voice": "flux-marcelo-en", "stream": true, "hasDeepgram": true }
```

Service logs for a spoken reply should include `deepgram-tts-ws pcm-stream` and a low `firstAudioMs` (waveOut starts after ~100ms preroll — Flux `firstByteMs` is time-to-first-PCM). Voice Cursor cannot start speaking until Cursor's `afterAgentResponse` hook fires, which is when the **full** reply is done — the chat UI may already have been streaming that text.

## Voices / speed / expressivity
- Flux models use `/v2/speak` (`flux-…`) — **WebSocket streaming by default**
- Aura models still use `/v1/speak` REST (`aura-…`) and ignore `VOICE_CURSOR_TTS_EXPRESSIVITY`
- Flux speed must be one of: `0.85`, `0.9`, `0.95`, `1.0`, `1.05`, `1.1`, `1.15`
- Flux expressivity (beta) is an integer `-2`…`2` (`calm` … `animated`), set at connect time — restart the service after changing it
- Voice catalog: https://developers.deepgram.com/docs/flux-tts/voices
- Force REST: `VOICE_CURSOR_TTS_STREAM=off`
