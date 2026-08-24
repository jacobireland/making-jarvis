# Deepgram setup (STT + TTS)

One Deepgram key can power both:
- **STT:** Nova (`nova-3`) on your push-to-talk WAV
- **TTS:** Flux (`flux-marcelo-en` by default) via `/v2/speak`

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
```

That matches:
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
"tts": { "resolved": "deepgram", "voice": "flux-marcelo-en", "hasDeepgram": true }
```

## Voices / speed
- Flux models use `/v2/speak` (`flux-…`)
- Aura models still use `/v1/speak` (`aura-…`)
- Flux speed must be one of: `0.85`, `0.9`, `0.95`, `1.0`, `1.05`, `1.1`, `1.15`
- Voice catalog: https://developers.deepgram.com/docs/flux-tts/voices
