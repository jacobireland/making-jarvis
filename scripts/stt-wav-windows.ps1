# Transcribe a WAV file with Windows System.Speech (with a hard timeout).
# Usage:
#   powershell ... -File stt-wav-windows.ps1 -WavFile C:\temp\clip.wav -TimeoutSeconds 20

param(
  [Parameter(Mandatory = $true)]
  [string]$WavFile,
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"

$WavFile = [System.IO.Path]::GetFullPath($WavFile)
if (-not (Test-Path -LiteralPath $WavFile)) {
  Write-Error "WAV not found: $WavFile"
}

$len = (Get-Item -LiteralPath $WavFile).Length
Write-Output ("meta bytes=" + $len)

Add-Type -AssemblyName System.Speech

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $engine.SetInputToWaveFile($WavFile)
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds([Math]::Min(5, $TimeoutSeconds))
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(2)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(400)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(400)

  $result = $engine.Recognize([TimeSpan]::FromSeconds($TimeoutSeconds))
  if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) {
    Write-Output ""
  } else {
    Write-Output $result.Text.Trim()
  }
} finally {
  if ($engine) { $engine.Dispose() }
}
