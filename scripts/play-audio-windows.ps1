# Play an audio file to completion using WPF MediaPlayer.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File play-audio-windows.ps1 -Path C:\temp\out.mp3

param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

$Path = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "Audio file not found: $Path"
}

$len = (Get-Item -LiteralPath $Path).Length
if ($len -lt 500) {
  Write-Error "Audio file too small ($len bytes): $Path"
}

Add-Type -AssemblyName PresentationCore

$player = New-Object System.Windows.Media.MediaPlayer
try {
  # MediaPlayer requires a URI; use file:/// form.
  $full = (Resolve-Path -LiteralPath $Path).Path
  $uri = [Uri]::new($full)
  $player.Volume = 1.0
  $player.Open($uri)

  $opened = $false
  for ($i = 0; $i -lt 200; $i++) {
    if ($player.NaturalDuration.HasTimeSpan) {
      $opened = $true
      break
    }
    Start-Sleep -Milliseconds 50
  }
  if (-not $opened) {
    Write-Error "MediaPlayer failed to open audio (no duration): $Path"
  }

  $durationMs = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds)
  if ($durationMs -lt 80) {
    Write-Error "Audio duration too short ($durationMs ms): $Path"
  }

  $player.Play()

  # Wait for playback to finish (duration + small buffer).
  Start-Sleep -Milliseconds ($durationMs + 500)

  try { $player.Stop() } catch {}
  Write-Output ("ok bytes=" + $len + " durationMs=" + $durationMs)
} finally {
  try { $player.Close() } catch {}
}
