# One-shot speech-to-text using Windows System.Speech (no cloud API).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File stt-windows.ps1 -Seconds 7

param(
  [int]$Seconds = 7
)

$ErrorActionPreference = "Stop"

if ($Seconds -lt 2) { $Seconds = 2 }
if ($Seconds -gt 30) { $Seconds = 30 }

Add-Type -AssemblyName System.Speech

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  try {
    $engine.SetInputToDefaultAudioDevice()
  } catch {
    Write-Error "No default microphone / audio input device available: $($_.Exception.Message)"
  }

  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds([Math]::Max(2, $Seconds))
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds($Seconds)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1200)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1200)

  $result = $engine.Recognize([TimeSpan]::FromSeconds($Seconds))
  if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) {
    Write-Output ""
  } else {
    Write-Output $result.Text.Trim()
  }
} finally {
  if ($engine) { $engine.Dispose() }
}
