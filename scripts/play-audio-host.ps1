# Persistent MCI playback host — keeps PowerShell + winmm warm.
# Node writes one absolute audio path per line on stdin; host replies "ok ..." or "err ...".
# Send "quit" to exit.

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoiceCursorMciPlayHost {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciSendStringW")]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr callback);
}
"@

function Invoke-Mci([string]$command) {
  $buf = New-Object System.Text.StringBuilder 256
  $code = [VoiceCursorMciPlayHost]::mciSendString($command, $buf, $buf.Capacity, [IntPtr]::Zero)
  if ($code -ne 0) {
    throw "MCI failed ($code): $command"
  }
}

function Play-One([string]$Path) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $Path = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Audio file not found: $Path"
  }
  $len = (Get-Item -LiteralPath $Path).Length
  if ($len -lt 500) {
    throw "Audio file too small ($len bytes)"
  }

  [void][VoiceCursorMciPlayHost]::mciSendString("close vcmedia", $null, 0, [IntPtr]::Zero)
  Invoke-Mci "open `"$Path`" type mpegvideo alias vcmedia"
  $openMs = $sw.ElapsedMilliseconds
  Invoke-Mci "play vcmedia wait"
  $totalMs = $sw.ElapsedMilliseconds
  [void][VoiceCursorMciPlayHost]::mciSendString("close vcmedia", $null, 0, [IntPtr]::Zero)
  Write-Output ("ok bytes=" + $len + " openMs=" + $openMs + " totalMs=" + $totalMs)
}

Write-Output "ready"
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -eq "quit") { break }
  try {
    Play-One $line
  } catch {
    Write-Output ("err " + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
