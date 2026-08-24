# making-jarvis (Voice Cursor)

Voice interface to the **existing Cursor Agent**. Cursor remains responsible for coding; this project only handles microphone → prompt injection → response capture → speech.

## Current status: Phase 2 (one-shot talk)

| Piece | Role |
|---|---|
| `extension/` | One-Shot Talk, inject/auto-submit, capture display |
| `voice-service/` | Local HTTP/WS on `127.0.0.1:4738` + Windows STT + Edge TTS |
| `.cursor/hooks/` | `afterAgentResponse` → service |
| `scripts/` | Windows Enter / STT / TTS helpers |
| `shared/` | Event types + `toSpokenText()` |

## Quick start (Windows)

```powershell
npm install
npm run build
npm run service
```

In Cursor (open the repo folder that contains `.cursor/hooks.json`):

1. **Developer: Install Extension from Location…** → select `extension/`
2. Command Palette → **Voice Cursor: Start Listening**
3. Speak, then **Voice Cursor: Stop Listening & Send**
4. Confirm transcript if prompted, wait for spoken reply

Details: [docs/phase2-oneshot.md](docs/phase2-oneshot.md) · Phase 1 checklist: [docs/spike-phase1.md](docs/spike-phase1.md)

## Design constraints

- Do **not** build a separate coding agent.
- Preserve normal Cursor Agent panel, diffs, and terminal.
- Auto-submit uses focus + Enter (UI automation); avoid clicking away mid-send.
