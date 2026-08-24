# Transcribe a WAV file with Windows System.Speech.
# Usage:
#   powershell ... -File stt-wav-windows.ps1 -WavFile C:\temp\clip.wav

param(
  [Parameter(Mandatory = $true)]
  [string]$WavFile
)

$ErrorActionPreference = "Stop"

$WavFile = [System.IO.Path]::GetFullPath($WavFile)
if (-not (Test-Path -LiteralPath $WavFile)) {
  Write-Error "WAV not found: $WavFile"
}

Add-Type -AssemblyName System.Speech

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $engine.SetInputToWaveFile($WavFile)
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(500)

  # Recognize the whole clip; timeout based on file size / rough duration ceiling.
  $result = $engine.Recognize([TimeSpan]::FromMinutes(2))
  if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) {
    Write-Output ""
  } else {
    Write-Output $result.Text.Trim()
  }
} finally {
  if ($engine) { $engine.Dispose() }
}
