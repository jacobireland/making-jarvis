# Phase 2 — Push-to-talk voice loop

## Flow
1. **Start Listening** (or click status bar)
2. Speak as long as you want
3. **Pause** — Deepgram Flux auto-sends on end-of-utterance. Or click **Stop Listening & Send**
4. Confirm transcript (optional setting) → Agent → spoken reply

WAV click-to-send is still the fallback when Flux listen isn't available.

## Commands
- `Voice Cursor: Start Listening`
- `Voice Cursor: Stop Listening & Send`
- `Voice Cursor: Cancel Listening`
- `Voice Cursor: One-Shot Talk` — start + prompt you to stop (helper)

## Settings
- `voiceCursor.confirmTranscript` — confirm before send (default **false**)
- `voiceCursor.oneShotNewChat` — new Agent chat each turn (default **false**; first turn opens one chat, then same thread)
- `voiceCursor.autoStartService` — spawn voice-service if down (default true)
- `voiceCursor.quietUi` — skip routine success toasts during PTT (default true)
- `voiceCursor.autoEndUtterance` — pause-to-send via Deepgram Flux (default **true**; click Stop still works)

## STT / TTS
- STT: **Deepgram Flux** streaming listen (`/v2/listen`) for end-of-utterance; Nova WAV if streaming isn't available (optional OpenAI Whisper, then Windows, as fallbacks)
- TTS: **Deepgram Flux** WebSocket streaming (Edge / Windows fallbacks)

See also: [phase3-reliability.md](phase3-reliability.md) · [deepgram-setup.md](deepgram-setup.md) · [openai-whisper-setup.md](openai-whisper-setup.md) (fallback)
