# Phase 2 — One-shot voice loop

Status: implemented (Windows STT/TTS via System.Speech)

## Flow
1. **Voice Cursor: One-Shot Talk** (or status bar click)
2. Confirm → mic listens ~N seconds (`voiceCursor.listenSeconds`, default 7)
3. Confirm transcript → inject + auto-submit into Cursor Agent
4. Wait for hook capture
5. Speak `spokenText` via Windows SAPI

## Requirements (Windows)
- Default microphone working
- Windows Speech Recognition available (`System.Speech`)
  - If STT returns empty often: install/enable speech language pack in Windows Settings
- Voice service running: `npm run service`
- Same workspace root as `.cursor/hooks.json`

## Test checklist
- [ ] `npm run build` && restart `npm run service`
- [ ] Reinstall extension from `extension/`
- [ ] One-Shot Talk → speak a short coding ask → confirm transcript
- [ ] Agent runs without manual Enter
- [ ] Reply is spoken aloud
- [ ] Don't click away during the short inject/send window

## Settings
- `voiceCursor.listenSeconds` — mic window length
- `voiceCursor.oneShotNewChat` — new Agent chat each turn (default true)

## Not in Phase 2
- Continuous listening / VAD
- Barge-in while TTS is playing
- Cloud STT/TTS providers
