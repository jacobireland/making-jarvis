# Record default microphone to a WAV file for N seconds (Windows MCI).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File record-mic-windows.ps1 -Seconds 7 -OutFile C:\temp\vc.wav

param(
  [int]$Seconds = 7,
  [Parameter(Mandatory = $true)]
  [string]$OutFile
)

$ErrorActionPreference = "Stop"

if ($Seconds -lt 2) { $Seconds = 2 }
if ($Seconds -gt 30) { $Seconds = 30 }

$OutFile = [System.IO.Path]::GetFullPath($OutFile)
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
if (Test-Path $OutFile) {
  Remove-Item -Force $OutFile
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoiceCursorMci {
  [DllImport("winmm.dll", CharSet = CharSet.Ansi)]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr callback);
}
"@

function Invoke-Mci([string]$command) {
  $buf = New-Object System.Text.StringBuilder 256
  $code = [VoiceCursorMci]::mciSendString($command, $buf, $buf.Capacity, [IntPtr]::Zero)
  if ($code -ne 0) {
    $err = New-Object System.Text.StringBuilder 256
    [void][VoiceCursorMci]::mciSendString("status recsound mode", $err, $err.Capacity, [IntPtr]::Zero)
    throw "MCI command failed ($code): $command"
  }
}

try {
  # Close any prior alias quietly.
  try { [void][VoiceCursorMci]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero) } catch {}

  Invoke-Mci "open new type waveaudio alias recsound"
  Invoke-Mci "set recsound time format ms bitspersample 16 channels 1 samplespersec 16000"
  Invoke-Mci "record recsound"
  Start-Sleep -Seconds $Seconds
  Invoke-Mci "stop recsound"
  # MCI save path needs quotes when spaces exist.
  $savePath = $OutFile.Replace('\', '\\')
  Invoke-Mci "save recsound `"$OutFile`""
  Invoke-Mci "close recsound"

  if (-not (Test-Path $OutFile)) {
    throw "Recording finished but file was not created: $OutFile"
  }
  $len = (Get-Item $OutFile).Length
  if ($len -lt 1000) {
    throw "Recording file too small ($len bytes) — check microphone permissions"
  }
  Write-Output "ok path=$OutFile bytes=$len"
} catch {
  try { [void][VoiceCursorMci]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero) } catch {}
  throw
}
