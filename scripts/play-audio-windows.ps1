# Play an audio file to completion (mp3/wav) using WMP COM.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File play-audio-windows.ps1 -Path C:\temp\out.mp3

param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

$Path = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path $Path)) {
  Write-Error "Audio file not found: $Path"
}

$player = New-Object -ComObject WMPlayer.OCX
try {
  $media = $player.newMedia($Path)
  $player.currentMedia = $media
  $player.controls.play()

  $waited = 0
  while ($player.playState -eq 0 -and $waited -lt 5000) {
    Start-Sleep -Milliseconds 50
    $waited += 50
  }

  while ($player.playState -eq 3) {
    Start-Sleep -Milliseconds 150
  }

  # 1 = stopped, 8 = media ended (common), 10 = ready
  Write-Output ("ok playState=" + $player.playState)
} finally {
  try { $player.controls.stop() } catch {}
  try { $player.close() } catch {}
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($player)
}
