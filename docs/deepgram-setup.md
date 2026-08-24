# Deepgram setup (STT + TTS)

One Deepgram key can power both:
- **STT:** Nova (`nova-3`) on your push-to-talk WAV
- **TTS:** Aura (`aura-2-odysseus-en` by default) for agent replies

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
VOICE_CURSOR_TTS_RATE=1.25
# Optional voice (Aura-2 models):
# VOICE_CURSOR_TTS_VOICE=aura-2-odysseus-en
# VOICE_CURSOR_TTS_VOICE=aura-2-hera-en
# VOICE_CURSOR_TTS_VOICE=aura-2-apollo-en
```

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
"tts": { "resolved": "deepgram", "hasDeepgram": true }
```

## Voices
Browse Aura models: https://developers.deepgram.com/docs/tts-models  
Set `VOICE_CURSOR_TTS_VOICE` to any `aura-2-…` model id.
