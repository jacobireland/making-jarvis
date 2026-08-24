# making-jarvis (Voice Cursor)

Voice interface to the **existing Cursor Agent**. Cursor remains responsible for coding; this project only handles microphone → prompt injection → response capture → speech.

## Current status: Phase 3 (reliability + same-thread chat)

| Piece | Role |
|---|---|
| `extension/` | Push-to-talk, auto-start service, inject into Agent (same-thread by default) |
| `voice-service/` | Local HTTP/WS on `127.0.0.1:4738` + Deepgram STT/TTS (Flux WebSocket streaming) |
| `.cursor/hooks/` | `afterAgentThought` + `afterAgentResponse` → service (spoken thoughts then final reply) |
| `scripts/` | Windows Enter / PCM play / STT helpers |
| `shared/` | Event types + `toSpokenText()` |

## Quick start (Windows)

```powershell
npm install
npm run build
```

In Cursor (open the repo folder that contains `.cursor/hooks.json`):

1. **Developer: Install Extension from Location…** → select `extension/`
2. Reload if needed — the extension **auto-starts** the voice service when possible
3. Command Palette → **Voice Cursor: Start Listening**
4. Speak, then **Voice Cursor: Stop Listening & Send**
5. Confirm transcript if prompted; follow-ups stay in the **same Agent chat**

Optional manual service: `npm run service` (leave running). Disable auto-start via `voiceCursor.autoStartService`.

Details: [docs/phase3-reliability.md](docs/phase3-reliability.md) · [docs/phase2-oneshot.md](docs/phase2-oneshot.md) · Deepgram: [docs/deepgram-setup.md](docs/deepgram-setup.md)

## Design constraints

- Do **not** build a separate coding agent.
- Preserve normal Cursor Agent panel, diffs, and terminal.
- Auto-submit uses focus + Enter (UI automation); avoid clicking away mid-send.
