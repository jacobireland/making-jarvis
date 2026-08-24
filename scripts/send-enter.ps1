# Focus a Cursor window, then send Enter (and optionally Ctrl+Enter).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File send-enter.ps1
#   powershell ... -File send-enter.ps1 -Chord ctrl-enter

param(
  [ValidateSet("enter", "ctrl-enter")]
  [string]$Chord = "enter"
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class VoiceCursorWin {
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
  $callback = [VoiceCursorWin+EnumProc]{
    param([IntPtr]$hwnd, [IntPtr]$lParam)
    if (-not [VoiceCursorWin]::IsWindowVisible($hwnd)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][VoiceCursorWin]::GetWindowText($hwnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    # Prefer real Cursor work windows; skip terminals / this script host.
    if ($title -match 'Cursor' -and $title -notmatch 'powershell|Windows Terminal|cmd\.exe|Voice Cursor') {
      $candidates.Add([pscustomobject]@{ Hwnd = $hwnd; Title = $title }) | Out-Null
    }
    return $true
  }
  [void][VoiceCursorWin]::EnumWindows($callback, [IntPtr]::Zero)

  if ($candidates.Count -eq 0) { return [IntPtr]::Zero }

  $preferred = $candidates | Where-Object {
    $_.Title -match 'making-jarvis|Making-Jarvis|Extension Development Host'
  } | Select-Object -First 1
  if ($preferred) { return [IntPtr]$preferred.Hwnd }
  return [IntPtr]$candidates[0].Hwnd
}

function Focus-Hwnd([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $false }

  # Do NOT call ShowWindow(SW_RESTORE): it can resize/maximize unexpectedly.
  $fg = [VoiceCursorWin]::GetForegroundWindow()
  $fgProcId = 0
  $foreThread = [VoiceCursorWin]::GetWindowThreadProcessId($fg, [ref]$fgProcId)
  $targetProcId = 0
  $targetThread = [VoiceCursorWin]::GetWindowThreadProcessId($hwnd, [ref]$targetProcId)
  $curThread = [VoiceCursorWin]::GetCurrentThreadId()

  if ($foreThread -ne $targetThread) {
    [void][VoiceCursorWin]::AttachThreadInput($curThread, $foreThread, $true)
    [void][VoiceCursorWin]::AttachThreadInput($curThread, $targetThread, $true)
  }

  [void][VoiceCursorWin]::BringWindowToTop($hwnd)
  $ok = [VoiceCursorWin]::SetForegroundWindow($hwnd)

  if ($foreThread -ne $targetThread) {
    [void][VoiceCursorWin]::AttachThreadInput($curThread, $foreThread, $false)
    [void][VoiceCursorWin]::AttachThreadInput($curThread, $targetThread, $false)
  }

  return $ok
}

function Send-Key([byte]$vk, [switch]$Down, [switch]$Up) {
  if ($Down) { [VoiceCursorWin]::keybd_event($vk, 0, 0, [UIntPtr]::Zero) }
  if ($Up) { [VoiceCursorWin]::keybd_event($vk, 0, [VoiceCursorWin]::KEYEVENTF_KEYUP, [UIntPtr]::Zero) }
}

$hwnd = Get-CursorHwnd
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Error "No Cursor window found to focus"
}

$focused = Focus-Hwnd $hwnd
Start-Sleep -Milliseconds 50

if ($Chord -eq "ctrl-enter") {
  Send-Key ([VoiceCursorWin]::VK_CONTROL) -Down
  Start-Sleep -Milliseconds 20
  Send-Key ([VoiceCursorWin]::VK_RETURN) -Down
  Start-Sleep -Milliseconds 20
  Send-Key ([VoiceCursorWin]::VK_RETURN) -Up
  Start-Sleep -Milliseconds 20
  Send-Key ([VoiceCursorWin]::VK_CONTROL) -Up
} else {
  Send-Key ([VoiceCursorWin]::VK_RETURN) -Down
  Start-Sleep -Milliseconds 20
  Send-Key ([VoiceCursorWin]::VK_RETURN) -Up
}

Write-Output ("ok focused=" + $focused + " chord=" + $Chord + " hwnd=" + $hwnd)
