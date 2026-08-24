# Persistent Enter host — keeps PowerShell + Win32 APIs warm.
# Node writes one chord per line on stdin: "enter" or "ctrl-enter"
# Host replies "ok ..." or "err ...". Send "quit" to exit.

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class VoiceCursorWinHost {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

  public const byte VK_RETURN = 0x0D;
  public const byte VK_CONTROL = 0x11;
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@

function Get-CursorHwnd {
  $candidates = New-Object System.Collections.Generic.List[object]
  $callback = [VoiceCursorWinHost+EnumProc]{
    param([IntPtr]$hwnd, [IntPtr]$lParam)
    if (-not [VoiceCursorWinHost]::IsWindowVisible($hwnd)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][VoiceCursorWinHost]::GetWindowText($hwnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    if ($title -match 'Cursor' -and $title -notmatch 'powershell|Windows Terminal|cmd\.exe|Voice Cursor') {
      $candidates.Add([pscustomobject]@{ Hwnd = $hwnd; Title = $title }) | Out-Null
    }
    return $true
  }
  [void][VoiceCursorWinHost]::EnumWindows($callback, [IntPtr]::Zero)

  if ($candidates.Count -eq 0) { return [IntPtr]::Zero }

  $preferred = $candidates | Where-Object {
    $_.Title -match 'making-jarvis|Making-Jarvis|Extension Development Host'
  } | Select-Object -First 1
  if ($preferred) { return [IntPtr]$preferred.Hwnd }
  return [IntPtr]$candidates[0].Hwnd
}

function Focus-Hwnd([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $false }

  $fg = [VoiceCursorWinHost]::GetForegroundWindow()
  $fgProcId = 0
  $foreThread = [VoiceCursorWinHost]::GetWindowThreadProcessId($fg, [ref]$fgProcId)
  $targetProcId = 0
  $targetThread = [VoiceCursorWinHost]::GetWindowThreadProcessId($hwnd, [ref]$targetProcId)
  $curThread = [VoiceCursorWinHost]::GetCurrentThreadId()

  if ($foreThread -ne $targetThread) {
    [void][VoiceCursorWinHost]::AttachThreadInput($curThread, $foreThread, $true)
    [void][VoiceCursorWinHost]::AttachThreadInput($curThread, $targetThread, $true)
  }

  [void][VoiceCursorWinHost]::BringWindowToTop($hwnd)
  $ok = [VoiceCursorWinHost]::SetForegroundWindow($hwnd)

  if ($foreThread -ne $targetThread) {
    [void][VoiceCursorWinHost]::AttachThreadInput($curThread, $foreThread, $false)
    [void][VoiceCursorWinHost]::AttachThreadInput($curThread, $targetThread, $false)
  }

  return $ok
}

function Send-Key([byte]$vk, [switch]$Down, [switch]$Up) {
  if ($Down) { [VoiceCursorWinHost]::keybd_event($vk, 0, 0, [UIntPtr]::Zero) }
  if ($Up) { [VoiceCursorWinHost]::keybd_event($vk, 0, [VoiceCursorWinHost]::KEYEVENTF_KEYUP, [UIntPtr]::Zero) }
}

function Send-Chord([string]$Chord) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $hwnd = Get-CursorHwnd
  if ($hwnd -eq [IntPtr]::Zero) { throw "No Cursor window found to focus" }

  $focused = Focus-Hwnd $hwnd
  Start-Sleep -Milliseconds 30

  if ($Chord -eq "ctrl-enter") {
    Send-Key ([VoiceCursorWinHost]::VK_CONTROL) -Down
    Start-Sleep -Milliseconds 15
    Send-Key ([VoiceCursorWinHost]::VK_RETURN) -Down
    Start-Sleep -Milliseconds 15
    Send-Key ([VoiceCursorWinHost]::VK_RETURN) -Up
    Start-Sleep -Milliseconds 15
    Send-Key ([VoiceCursorWinHost]::VK_CONTROL) -Up
  } else {
    Send-Key ([VoiceCursorWinHost]::VK_RETURN) -Down
    Start-Sleep -Milliseconds 15
    Send-Key ([VoiceCursorWinHost]::VK_RETURN) -Up
  }

  Write-Output ("ok focused=" + $focused + " chord=" + $Chord + " hwnd=" + $hwnd + " ms=" + $sw.ElapsedMilliseconds)
}

Write-Output "ready"
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -eq "quit") { break }
  if ($line -ne "enter" -and $line -ne "ctrl-enter") {
    Write-Output ("err unknown chord: " + $line)
    [Console]::Out.Flush()
    continue
  }
  try {
    Send-Chord $line
  } catch {
    Write-Output ("err " + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
