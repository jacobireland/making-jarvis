# Speak text with Windows SAPI (System.Speech).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tts-windows.ps1 -Text "Hello"

param(
  [Parameter(Mandatory = $true)]
  [string]$Text
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Text)) {
  Write-Output "ok empty=true"
  exit 0
}

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  # -10..10; 3 ≈ noticeably faster cadence for agent replies
  $synth.Rate = 3
  $synth.Volume = 100
  $synth.Speak($Text)
  Write-Output "ok"
} finally {
  $synth.Dispose()
}
