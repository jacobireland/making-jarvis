# making-jarvis (Voice Cursor)

Voice interface to the **existing Cursor Agent**. Cursor remains responsible for coding; this project only handles microphone → prompt injection → response capture → speech.

## Current status: Phase 3 + pause-to-send

| Piece | Role |
|---|---|
| `extension/` | Push-to-talk / pause-to-send, auto-start service, inject into Agent (same-thread by default) |
| `voice-service/` | Local HTTP/WS on `127.0.0.1:4738` + Deepgram STT/TTS (Flux listen + Flux speak; Whisper/Windows STT fallbacks) |
| `.cursor/hooks/` | `afterAgentThought` + `afterAgentResponse` → service (spoken thoughts then final reply) |
| `scripts/` | Windows Enter / PCM play / PCM capture / PTT WAV STT helpers |
| `shared/` | Event types + `toSpokenText()` |

## Quick start (Windows)

```powershell
npm install
npm run build
```

In Cursor (open the repo folder that contains `.cursor/hooks.json`):

1. **Developer: Install Extension from Location…** → select `extension/`
2. Reload if needed — the extension **auto-starts** the voice service when possible
3. Command Palette → **Voice Cursor: Start Listening**, or click **Voice Cursor: idle** in the status bar to turn listening on
4. Speak, then **pause** (Flux auto-sends). After the spoken reply, listening **comes back on**. Click the status-bar item to **turn listening off**, or **send now**.
5. Follow-ups stay in the **same Agent chat**

Optional manual service: `npm run service` (leave running). Disable auto-start via `voiceCursor.autoStartService`.

Details: [docs/phase3-reliability.md](docs/phase3-reliability.md) · [docs/phase2-oneshot.md](docs/phase2-oneshot.md) · Deepgram (primary STT/TTS): [docs/deepgram-setup.md](docs/deepgram-setup.md) · Whisper (optional STT fallback): [docs/openai-whisper-setup.md](docs/openai-whisper-setup.md)

## Design constraints

- Do **not** build a separate coding agent.
- Preserve normal Cursor Agent panel, diffs, and terminal.
- Auto-submit uses focus + Enter (UI automation); avoid clicking away mid-send.
