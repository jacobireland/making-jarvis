# Phase 3 — Reliability + conversation continuity

## What's new
1. **Auto-start voice service** — on activate (and on reconnect), the extension starts `voice-service/dist/index.js` if `/health` is down (`voiceCursor.autoStartService`, default on).
2. **Same-thread chat** — `voiceCursor.oneShotNewChat` defaults to **false**: first turn this session opens one Agent chat, later turns stay in that thread. Set it **true** for a new chat every turn.

## Flow (unchanged)
1. **Start Listening** → speak → **Stop Listening & Send**
2. Transcript → inject into Agent → spoken reply

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `voiceCursor.autoStartService` | `true` | Spawn local service if unreachable |
| `voiceCursor.oneShotNewChat` | `false` | `true` = new chat each turn; `false` = same thread after first open |
| `voiceCursor.confirmTranscript` | `true` | Confirm before send |
| `voiceCursor.serviceUrl` | `http://127.0.0.1:4738` | Service base URL |

## Notes
- Auto-start needs a prior `npm run build` so `voice-service/dist/index.js` exists.
- You can still run `npm run service` yourself; the extension will reuse it and will not double-start.
- If the extension started the service, it stops that managed process on deactivate.
