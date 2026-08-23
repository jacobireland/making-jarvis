# Phase 2 — One-shot voice loop

Status: implemented (Whisper STT when API key set; Windows speech fallback)

## Flow
1. **Voice Cursor: One-Shot Talk** (or status bar click)
2. Confirm → mic listens ~N seconds (`voiceCursor.listenSeconds`, default 7)
3. Confirm transcript → inject + auto-submit into Cursor Agent
4. Wait for hook capture
5. Speak `spokenText` via Windows SAPI

## STT engines
Set in repo-root `.env` (see `.env.example`):

| `VOICE_CURSOR_STT` | Behavior |
|---|---|
| `auto` (default) | OpenAI Whisper if `OPENAI_API_KEY`, else Groq if `GROQ_API_KEY`, else Windows |
| `whisper-openai` | Require OpenAI key; record wav → Whisper |
| `whisper-groq` | Require Groq key; record wav → Whisper |
| `windows` | Force Windows `System.Speech` (lower accuracy) |

```powershell
copy .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...
npm run service
curl http://127.0.0.1:4738/health
# check "stt": { "resolved": "whisper-openai", ... }
```

## Requirements (Windows)
- Default microphone working + mic permission for PowerShell/Cursor if prompted
- For Whisper: network + API key
- Voice service running from repo root: `npm run service`
- Same workspace root as `.cursor/hooks.json`

## Test checklist
- [ ] `.env` has `OPENAI_API_KEY` (or Groq)
- [ ] `npm run build` && restart `npm run service`
- [ ] `curl http://127.0.0.1:4738/health` shows whisper resolved
- [ ] One-Shot Talk → speak clearly → transcript looks accurate
- [ ] Agent runs + reply is spoken

## Settings
- `voiceCursor.listenSeconds` — mic window length
- `voiceCursor.oneShotNewChat` — new Agent chat each turn (default true)

## Not in Phase 2
- Continuous listening / VAD
- Barge-in while TTS is playing
