# Phase 2 — Push-to-talk voice loop

## Flow
1. **Voice Cursor: Start Listening** (or click status bar)
2. Speak as long as you want
3. **Voice Cursor: Stop Listening & Send** (or click status bar again)
4. Confirm transcript (optional setting) → Agent → spoken reply

The old fixed-window `/stt/listen` debug path is gone. Normal use is push-to-talk: `/stt/start` then `/stt/stop`.

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

## STT / TTS
- STT: **Deepgram Nova** (optional OpenAI Whisper, then Windows, as fallbacks)
- TTS: **Deepgram Flux** WebSocket streaming (Edge / Windows fallbacks)

See also: [phase3-reliability.md](phase3-reliability.md) · [deepgram-setup.md](deepgram-setup.md) · [openai-whisper-setup.md](openai-whisper-setup.md) (fallback)
