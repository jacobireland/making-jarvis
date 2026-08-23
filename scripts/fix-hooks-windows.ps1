# Fixes Cursor hooks on Windows when `node` works in the terminal
# but NOT when Cursor spawns hooks (common with nvm/fnm).
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-hooks-windows.ps1

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$hooksPath = Join-Path $root ".cursor\hooks.json"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "Could not find node on PATH. Install Node.js or open a shell where 'node -v' works."
}
$node = $nodeCmd.Source

Write-Host "Using node at: $node"

$relay = Join-Path $root ".cursor\hooks\relay.js"
if (-not (Test-Path $relay)) {
  Write-Error "Missing relay script at $relay"
}

$relayRel = ".cursor/hooks/relay.js"
$nodeEscaped = $node.Replace("\", "\\")

@"
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "\"$nodeEscaped\" $relayRel session-start",
        "timeout": 5000
      }
    ],
    "afterAgentResponse": [
      {
        "command": "\"$nodeEscaped\" $relayRel after-agent-response",
        "timeout": 5000
      }
    ],
    "stop": [
      {
        "command": "\"$nodeEscaped\" $relayRel stop",
        "timeout": 5000
      }
    ]
  }
}
"@ | Set-Content -Path $hooksPath -Encoding UTF8

Write-Host "Updated $hooksPath"
Write-Host ""
Write-Host "Next:"
Write-Host "1) Ctrl+Shift+P -> Developer: Reload Window"
Write-Host "2) Keep npm run service running"
Write-Host "3) Send a normal Agent chat message and press Enter"
Write-Host "4) Check:"
Write-Host "   - .cursor\spike-events.jsonl"
Write-Host "   - $env:TEMP\voice-cursor-hooks.log"
Write-Host "   - curl http://127.0.0.1:4738/events"
