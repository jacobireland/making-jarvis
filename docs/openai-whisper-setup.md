# OpenAI Whisper setup (recommended STT)

## 1. Get an API key
1. Go to https://platform.openai.com/api-keys
2. Sign in / create an account
3. **Create new secret key**
4. Copy it (starts with `sk-...`)
5. Ensure billing is enabled on the account (Whisper is cheap pay-as-you-go)

## 2. Put the key in this repo
In `making-jarvis` repo root:

```powershell
copy .env.example .env
notepad .env
```

Set:
```env
OPENAI_API_KEY=sk-your-key-here
VOICE_CURSOR_STT=auto
```

## 3. Restart the voice service
```powershell
git pull
npm run build
npm run service
```

Confirm:
```powershell
curl http://127.0.0.1:4738/health
```

You want something like:
```json
"stt": { "resolved": "whisper-openai", "hasOpenAI": true }
```

Service log should also show:
```text
STT ... resolved=whisper-openai openai=true
```

## 4. Test push-to-talk
1. Reinstall extension from `extension/` if needed
2. **Start Listening** → speak → **Stop Listening & Send**
3. Transcript should be much more accurate

## Cost
Whisper is billed per audio minute (usually fractions of a cent per short clip). Personal IDE use is typically tiny.
