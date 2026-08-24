# Phase 2 — Push-to-talk voice loop

## Flow
1. **Voice Cursor: Start Listening** (or click status bar)
2. Speak as long as you want
3. **Voice Cursor: Stop Listening & Send** (or click status bar again)
4. Confirm transcript (optional setting) → Agent → spoken reply

Fixed 7s listen is no longer required for normal use.

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
- STT: Deepgram Nova (Whisper / Windows fallbacks)
- TTS: Deepgram Flux WebSocket streaming (Edge / Windows fallbacks)

See also: [phase3-reliability.md](phase3-reliability.md)
