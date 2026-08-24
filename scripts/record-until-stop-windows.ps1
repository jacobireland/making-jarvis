# Record microphone until a stop-file appears (or MaxSeconds).
# Usage:
#   powershell ... -File record-until-stop-windows.ps1 -OutFile out.wav -StopFile stop.flag -MaxSeconds 120

param(
  [Parameter(Mandatory = $true)]
  [string]$OutFile,
  [Parameter(Mandatory = $true)]
  [string]$StopFile,
  [int]$MaxSeconds = 120
)

$ErrorActionPreference = "Stop"

if ($MaxSeconds -lt 2) { $MaxSeconds = 2 }
if ($MaxSeconds -gt 300) { $MaxSeconds = 300 }

$OutFile = [System.IO.Path]::GetFullPath($OutFile)
$StopFile = [System.IO.Path]::GetFullPath($StopFile)
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
if (Test-Path $OutFile) { Remove-Item -Force $OutFile }
if (Test-Path $StopFile) { Remove-Item -Force $StopFile }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoiceCursorMciRec {
  [DllImport("winmm.dll", CharSet = CharSet.Ansi)]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr callback);
}
"@

function Invoke-Mci([string]$command) {
  $buf = New-Object System.Text.StringBuilder 256
  $code = [VoiceCursorMciRec]::mciSendString($command, $buf, $buf.Capacity, [IntPtr]::Zero)
  if ($code -ne 0) {
    throw "MCI command failed ($code): $command"
  }
}

try {
  try { [void][VoiceCursorMciRec]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero) } catch {}

  Invoke-Mci "open new type waveaudio alias recsound"
  Invoke-Mci "set recsound time format ms bitspersample 16 channels 1 samplespersec 16000"
  Invoke-Mci "record recsound"

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $MaxSeconds) {
    if (Test-Path -LiteralPath $StopFile) { break }
    Start-Sleep -Milliseconds 150
  }

  Invoke-Mci "stop recsound"
  Invoke-Mci "save recsound `"$OutFile`""
  Invoke-Mci "close recsound"

  if (-not (Test-Path -LiteralPath $OutFile)) {
    throw "Recording finished but file missing: $OutFile"
  }
  $len = (Get-Item -LiteralPath $OutFile).Length
  Write-Output ("ok path=" + $OutFile + " bytes=" + $len + " ms=" + [int]$sw.Elapsed.TotalMilliseconds)
} catch {
  try { [void][VoiceCursorMciRec]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero) } catch {}
  throw
}
