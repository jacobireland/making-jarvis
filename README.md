# making-jarvis (Voice Cursor)

Voice interface to the **existing Cursor Agent**. Cursor remains responsible for coding; this project only handles microphone → prompt injection → response capture → speech.

## Current status: Phase 1 spike

Scaffold for proving the IDE bridge:

| Piece | Role |
|---|---|
| `extension/` | Cursor/VS Code extension: inventory commands, inject test prompts, show captured replies |
| `voice-service/` | Local HTTP + WebSocket service on `127.0.0.1:4738` |
| `.cursor/hooks/` | `afterAgentResponse` / `stop` relay into the voice service |
| `shared/` | Event types + `toSpokenText()` sanitization |

Follow **[docs/spike-phase1.md](docs/spike-phase1.md)** for the experiment checklist.

## Quick start

```bash
npm install
npm run build
npm run service
```

In Cursor:

1. Install / run the `extension` package (Extensions: Install from Location → `extension/`, or launch via F5).
2. Command Palette → **Voice Cursor: Inventory Agent Commands**
3. Command Palette → **Voice Cursor: Send Test Prompt**

## Design constraints

- Do **not** build a separate coding agent.
- Preserve normal Cursor Agent panel, diffs, and terminal.
- Continuous VAD listening and TTS come after the Phase 1 Go decision.
