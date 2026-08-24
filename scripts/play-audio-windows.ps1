# Play mp3/wav via MCI (starts quickly; blocks until finished).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File play-audio-windows.ps1 -Path C:\temp\out.mp3

param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$Path = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "Audio file not found: $Path"
}

$len = (Get-Item -LiteralPath $Path).Length
$ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
$minLen = if ($ext -eq ".wav") { 200 } else { 500 }
if ($len -lt $minLen) {
  Write-Error "Audio file too small ($len bytes): $Path"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoiceCursorMciPlay {
  [DllImport("winmm.dll", CharSet = CharSet.Ansi)]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr callback);
}
"@

function Invoke-Mci([string]$command) {
  $buf = New-Object System.Text.StringBuilder 256
  $code = [VoiceCursorMciPlay]::mciSendString($command, $buf, $buf.Capacity, [IntPtr]::Zero)
  if ($code -ne 0) {
    throw "MCI failed ($code): $command"
  }
  return $buf.ToString()
}

try {
  try { [void][VoiceCursorMciPlay]::mciSendString("close vcmedia", $null, 0, [IntPtr]::Zero) } catch {}

  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($ext -eq ".wav") {
    Invoke-Mci "open `"$Path`" type waveaudio alias vcmedia"
  } else {
    # mpegvideo alias handles mp3 on most Windows installs.
    Invoke-Mci "open `"$Path`" type mpegvideo alias vcmedia"
  }
  $openMs = $sw.ElapsedMilliseconds

  # play ... wait blocks until playback completes.
  Invoke-Mci "play vcmedia wait"
  $totalMs = $sw.ElapsedMilliseconds

  Invoke-Mci "close vcmedia"
  Write-Output ("ok bytes=" + $len + " openMs=" + $openMs + " totalMs=" + $totalMs)
} catch {
  try { [void][VoiceCursorMciPlay]::mciSendString("close vcmedia", $null, 0, [IntPtr]::Zero) } catch {}
  throw
}
