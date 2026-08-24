# Phase 3 — Reliability + conversation continuity

## What's new
1. **Auto-start voice service** — on activate (and on reconnect), the extension starts `voice-service/dist/index.js` if `/health` is down (`voiceCursor.autoStartService`, default on).
2. **Same-thread chat** — `voiceCursor.oneShotNewChat` defaults to **false**: first turn this session opens one Agent chat, later turns stay in that thread. Set it **true** for a new chat every turn.
3. **Speak thinking blocks** — `afterAgentThought` speaks the short Thought preview line Cursor shows in chat (not the full expanded body). Set `VOICE_CURSOR_SPEAK_FULL_THOUGHTS=1` for the full text; disable entirely with `VOICE_CURSOR_SPEAK_THOUGHTS=0`.

## Flow (unchanged)
1. **Start Listening** → speak → **Stop Listening & Send**
2. Transcript → inject into Agent → spoken thoughts (as blocks complete) → spoken final reply

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `voiceCursor.autoStartService` | `true` | Spawn local service if unreachable |
| `voiceCursor.oneShotNewChat` | `false` | `true` = new chat each turn; `false` = same thread after first open |
| `voiceCursor.confirmTranscript` | `false` | Confirm before send (off by default for faster turns) |
| `voiceCursor.quietUi` | `true` | Skip routine success toasts during push-to-talk |
| `voiceCursor.serviceUrl` | `http://127.0.0.1:4738` | Service base URL |

## Env (service)
| Variable | Default | Meaning |
|---|---|---|
| `VOICE_CURSOR_SPEAK_THOUGHTS` | `true` | Speak `afterAgentThought` blocks during an armed voice turn |
| `VOICE_CURSOR_SPEAK_FULL_THOUGHTS` | `false` | `true` = full expanded Thought; default = short chat preview line only |

## Notes
- Auto-start needs a prior `npm run build` so `voice-service/dist/index.js` exists.
- You can still run `npm run service` yourself; the extension will reuse it and will not double-start.
- If the extension started the service, it stops that managed process on deactivate.
- Thought and final reply TTS are queued so neither drops; PTT waits only for the final-reply `tts_done`.
