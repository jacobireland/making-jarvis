# Record microphone until a stop-file appears (or MaxSeconds).
# Usage:
#   powershell ... -File record-until-stop-windows.ps1 -OutFile out.wav -StopFile stop.flag -MaxSeconds 120
#
# Writes progress to <OutFile>.log and failures to <OutFile>.err for the Node service.

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
$LogFile = "$OutFile.log"
$ErrFile = "$OutFile.err"
$dir = Split-Path -Parent $OutFile

function Write-Log([string]$msg) {
  $line = ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $msg)
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}

try {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
  if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force }
  if (Test-Path -LiteralPath $LogFile) { Remove-Item -LiteralPath $LogFile -Force }
  if (Test-Path -LiteralPath $ErrFile) { Remove-Item -LiteralPath $ErrFile -Force }

  Write-Log "start OutFile=$OutFile StopFile=$StopFile MaxSeconds=$MaxSeconds"

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoiceCursorMciRec2 {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciSendStringW")]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr callback);

  [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciGetErrorStringW")]
  public static extern bool mciGetErrorString(int errorCode, StringBuilder buffer, int bufferLength);
}
"@

  function Get-MciError([int]$code) {
    $buf = New-Object System.Text.StringBuilder 256
    [void][VoiceCursorMciRec2]::mciGetErrorString($code, $buf, $buf.Capacity)
    return $buf.ToString()
  }

  function Invoke-Mci([string]$command) {
    $buf = New-Object System.Text.StringBuilder 256
    $code = [VoiceCursorMciRec2]::mciSendString($command, $buf, $buf.Capacity, [IntPtr]::Zero)
    if ($code -ne 0) {
      $detail = Get-MciError $code
      throw "MCI failed ($code): $detail | cmd=$command"
    }
    return $buf.ToString()
  }

  function Invoke-MciSoft([string]$command) {
    $buf = New-Object System.Text.StringBuilder 256
    return [VoiceCursorMciRec2]::mciSendString($command, $buf, $buf.Capacity, [IntPtr]::Zero)
  }

  [void](Invoke-MciSoft "close recsound")

  Invoke-Mci "open new type waveaudio alias recsound"
  Write-Log "opened waveaudio"

  # Prefer device defaults — forcing format breaks many Windows mics.
  [void](Invoke-MciSoft "set recsound time format ms")

  Invoke-Mci "record recsound"
  Write-Log "recording"

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $MaxSeconds) {
    if (Test-Path -LiteralPath $StopFile) {
      Write-Log "stop file seen at ms=$([int]$sw.Elapsed.TotalMilliseconds)"
      break
    }
    Start-Sleep -Milliseconds 100
  }

  if ($sw.Elapsed.TotalMilliseconds -lt 250) {
    Start-Sleep -Milliseconds 250
  }

  [void](Invoke-MciSoft "stop recsound")
  Write-Log "stopped"

  # Wait until MCI reports stopped (up to ~2s).
  for ($i = 0; $i -lt 20; $i++) {
    $modeBuf = New-Object System.Text.StringBuilder 64
    [void][VoiceCursorMciRec2]::mciSendString("status recsound mode", $modeBuf, $modeBuf.Capacity, [IntPtr]::Zero)
    $mode = $modeBuf.ToString().Trim().ToLowerInvariant()
    if ($mode -eq "stopped" -or $mode -eq "not ready" -or [string]::IsNullOrWhiteSpace($mode)) { break }
    Start-Sleep -Milliseconds 100
  }

  $saved = $false
  $saveErrors = @()
  foreach ($cmd in @(
      ("save recsound `"$OutFile`""),
      ("save recsound $OutFile")
    )) {
    try {
      Invoke-Mci $cmd
      $saved = $true
      Write-Log "saved via: $cmd"
      break
    } catch {
      $saveErrors += $_.Exception.Message
      Write-Log "save failed: $($_.Exception.Message)"
    }
  }

  [void](Invoke-MciSoft "close recsound")

  if (-not $saved) {
    throw ("save failed: " + ($saveErrors -join " | "))
  }
  if (-not (Test-Path -LiteralPath $OutFile)) {
    throw "Recording finished but file missing: $OutFile"
  }

  $len = (Get-Item -LiteralPath $OutFile).Length
  Write-Log "ok bytes=$len ms=$([int]$sw.Elapsed.TotalMilliseconds)"
  Write-Output ("ok path=" + $OutFile + " bytes=" + $len + " ms=" + [int]$sw.Elapsed.TotalMilliseconds)
} catch {
  $msg = $_.Exception.Message
  try { Add-Content -LiteralPath $ErrFile -Value $msg -Encoding utf8 } catch {}
  try { Write-Log "ERROR $msg" } catch {}
  try { [void][VoiceCursorMciRec2]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero) } catch {}
  Write-Error $msg
  exit 1
}
