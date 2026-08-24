# Phase 3 — Reliability + conversation continuity

## What's new
1. **Auto-start voice service** — on activate (and on reconnect), the extension starts `voice-service/dist/index.js` if `/health` is down (`voiceCursor.autoStartService`, default on).
2. **Same-thread chat** — `voiceCursor.oneShotNewChat` defaults to **false**: first turn this session opens one Agent chat, later turns stay in that thread. Set it **true** for a new chat every turn.
3. **Speak thinking blocks** — `afterAgentThought` speaks the **last sentence** of each Thought (the usual chat preview line). Set `VOICE_CURSOR_SPEAK_FULL_THOUGHTS=1` for the full text; disable entirely with `VOICE_CURSOR_SPEAK_THOUGHTS=0`.
4. **Pause-to-send (VAD)** — with a Deepgram key, Start Listening streams the mic to Flux STT. A pause auto-sends (`EndOfTurn`). Click Stop & Send still works. Set `voiceCursor.autoEndUtterance` to **false** for classic click-to-send. Disable in the service with `VOICE_CURSOR_VAD=0`.

## Flow
1. Click the status-bar **Voice Cursor** item to turn listening **on** (idle) or **off** (while armed)
2. Speak → **pause to send**, or status-bar click → **Send now**
3. Transcript → inject into Agent → spoken thoughts → spoken final reply

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `voiceCursor.autoStartService` | `true` | Spawn local service if unreachable |
| `voiceCursor.oneShotNewChat` | `false` | `true` = new chat each turn; `false` = same thread after first open |
| `voiceCursor.confirmTranscript` | `false` | Confirm before send (off by default for faster turns) |
| `voiceCursor.quietUi` | `true` | Skip routine success toasts during push-to-talk |
| `voiceCursor.autoEndUtterance` | `true` | Auto-send when Flux detects end of utterance |
| `voiceCursor.serviceUrl` | `http://127.0.0.1:4738` | Service base URL |

## Env (service)
| Variable | Default | Meaning |
|---|---|---|
| `VOICE_CURSOR_SPEAK_THOUGHTS` | `true` | Speak `afterAgentThought` blocks during an armed voice turn |
| `VOICE_CURSOR_SPEAK_FULL_THOUGHTS` | `false` | `true` = full expanded Thought; default = last sentence only |
| `VOICE_CURSOR_TTS_VOICE` | `flux-marcelo-en` | Flux (or Aura) TTS voice / model |
| `VOICE_CURSOR_TTS_RATE` | `1.1` | Flux speaking rate (`0.85`–`1.15` in `0.05` steps) |
| `VOICE_CURSOR_TTS_EXPRESSIVITY` | `0` | Flux delivery register (`-2` calm … `2` animated). Restart service after changing. |
| `VOICE_CURSOR_VAD` | `true` | `0` = never stream Flux listen (WAV click-to-send only) |
| `VOICE_CURSOR_EOT_THRESHOLD` | `0.7` | Flux end-of-turn confidence (`0.5`–`0.9`; higher = more patient) |
| `VOICE_CURSOR_EOT_TIMEOUT_MS` | `7000` | Force EndOfTurn after this much silence |

## Notes
- Auto-start needs a prior `npm run build` so `voice-service/dist/index.js` exists.
- You can still run `npm run service` yourself; the extension will reuse it and will not double-start.
- If the extension started the service, it stops that managed process on deactivate.
- Thought and final reply TTS are queued so neither drops; PTT waits only for the final-reply `tts_done`.
- Pause-to-send does **not** listen during TTS (barge-in is still queued). After the reply, click Start Listening again.
- If Flux listen or the PCM capture host fails, the service falls back to WAV click-to-send for that turn.
