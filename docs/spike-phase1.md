# Phase 1 Spike Checklist — Voice Cursor bridge

Status: **in progress** (scaffold landed; run experiments in Cursor desktop)

Goal: prove **prompt in** + **response out** for the existing Cursor Agent before mic/TTS.

## 0. Setup
- [ ] Open this repo in **Cursor** (not plain VS Code)
- [ ] `npm install`
- [ ] `npm run build`
- [ ] Start service: `npm run service` (http://127.0.0.1:4738)
- [ ] Install / Run the extension from `extension/` (Extensions: Install from Location, or F5 debug)
- [ ] Confirm Agent chat works manually once

## 1. Inventory: what can submit a prompt?
- [ ] Command Palette → run **Voice Cursor: Inventory Agent Commands**
- [ ] Review generated `docs/spike-command-inventory.md`
- [ ] Note promising `composer.*` / `aichat.*` / submit command IDs
- [ ] Try **Voice Cursor: Send Test Prompt** with strategy `auto`
- [ ] Record whether prompt opened **new** chat, **current** chat, or failed
- [ ] If paste works but submit does not: press Enter manually once, still count as partial pass for capture testing

**Pass:** at least one method gets text into Agent and produces a normal turn.

## 2. Capture completed Agent response
- [ ] Ensure `.cursor/hooks.json` is loaded (reload window after clone if needed)
- [ ] Ensure voice service is running
- [ ] Manually run one Agent prompt
- [ ] Check `.cursor/spike-events.jsonl` for hook payload
- [ ] Check service: `curl -s http://127.0.0.1:4738/events | jq`
- [ ] Confirm extension status bar / info toast shows captured spoken text

**Pass:** every Agent turn yields usable final text via hook → service → extension.

## 3. Text-only end-to-end
- [ ] Run **Voice Cursor: Send Test Prompt** with `SPIKE: reply with exactly PONG and nothing else.`
- [ ] Watch Agent panel for the exchange
- [ ] Confirm captured response appears in Voice Cursor output channel
- [ ] Confirm timeout/error path if service is down

**Pass:** one extension command → visible Agent turn → captured final text.

## 4. Current conversation quality
- [ ] Send 2–3 follow-ups via the extension
- [ ] Result is: **A** same thread / **B** new thread each time / **C** unreliable
- [ ] Document focus requirements (Agent panel open, etc.)

## 5. Fallback (only if §1 fails)
- [ ] Evaluate `@cursor/sdk` one-shot `Agent.prompt` against this workspace
- [ ] Compare chat continuity vs IDE diff visibility
- [ ] Decide Path A vs Path B in §8

## 6. Spoken sanitization
- [x] `toSpokenText()` implemented in `shared/src/spoken.ts`
- [x] Unit tests for short / code-heavy / long / empty
- [ ] Paste 5 real Agent responses into notes below and verify spoken output

### Spoken samples
| Raw summary | Spoken output | OK? |
|---|---|---|
| | | |
| | | |
| | | |
| | | |
| | | |

## 7. Local service handshake
- [x] `/health`, `/events`, `/hooks/after-agent-response`, `/ws`
- [x] Hook relay posts to service
- [x] Extension websocket consumes `agent_response`
- [ ] Live verify on your machine with Cursor hooks firing

## 8. Decision gate
Choose one and sign off:

- [ ] **Path A:** Extension injects into Agent chat + hooks capture reply
- [ ] **Path B:** SDK/API runs agent; Cursor remains visual cockpit
- [ ] **Path C:** Blocked — do not build VAD/TTS yet

Notes:
- Same-thread support:
- Auth / permissions:
- Flaky cases:
- Go/No-Go for Phase 2:

## Quick commands
```bash
npm install
npm run build
npm run service
curl -s http://127.0.0.1:4738/health
# after an agent turn:
curl -s http://127.0.0.1:4738/events
tail -n 5 .cursor/spike-events.jsonl
```
