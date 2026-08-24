# Phase 2 — One-shot voice loop

Status: implemented (Windows System.Speech STT + SAPI TTS)

## Flow
1. **Voice Cursor: One-Shot Talk** (or status bar click)
2. Confirm → mic listens ~N seconds (`voiceCursor.listenSeconds`, default 7)
3. Confirm transcript → inject + auto-submit into Cursor Agent
4. Wait for hook capture
5. Speak `spokenText` via **Edge TTS** (`en-PH-JamesNeural` by default), with Windows SAPI fallback

## TTS
Default voice: **English (Philippines) James** — `en-PH-JamesNeural`

Optional env vars when starting the service:
```powershell
$env:VOICE_CURSOR_TTS="edge"                 # or "windows"
$env:VOICE_CURSOR_TTS_VOICE="en-PH-JamesNeural"
npm run service
```

Needs internet for Edge TTS. If Edge fails, it falls back to Windows SAPI.

## Requirements (Windows)
- Default microphone working
- Windows Speech Recognition / language pack available
- Voice service running: `npm run service`
- Same workspace root as `.cursor/hooks.json`

## Test checklist
- [ ] `npm run build` && restart `npm run service`
- [ ] Reinstall extension from `extension/`
- [ ] One-Shot Talk → speak a short ask → confirm transcript
- [ ] Agent runs without manual Enter
- [ ] Reply is spoken aloud

## Settings
- `voiceCursor.listenSeconds` — mic window length
- `voiceCursor.oneShotNewChat` — new Agent chat each turn (default true)

## Not in Phase 2
- Continuous listening / VAD
- Barge-in while TTS is playing
- Cloud STT (Whisper, etc.)
