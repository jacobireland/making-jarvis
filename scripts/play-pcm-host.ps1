# Persistent linear16 PCM playback host (waveOut) — gapless streaming.
# Node protocol (one UTF-8 line per message):
#   start <sampleRate> <channels> <bits>
#   pcm <base64>
#   end
#   quit
# Host replies:
#   ready
#   first          (first buffer handed to waveOut after start)
#   ok bytes=N firstMs=N totalMs=N
#   err <message>

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class VoiceCursorPcmPlayer : IDisposable {
  [StructLayout(LayoutKind.Sequential)]
  private class WaveFormat {
    public short wFormatTag;
    public short nChannels;
    public int nSamplesPerSec;
    public int nAvgBytesPerSec;
    public short nBlockAlign;
    public short wBitsPerSample;
    public short cbSize;
  }

  [StructLayout(LayoutKind.Sequential)]
  private class WaveHdr {
    public IntPtr lpData;
    public int dwBufferLength;
    public int dwBytesRecorded;
    public IntPtr dwUser;
    public int dwFlags;
    public int dwLoops;
    public IntPtr lpNext;
    public IntPtr reserved;
  }

  private const int WAVE_MAPPER = -1;
  private const int CALLBACK_NULL = 0;
  private const int WHDR_DONE = 0x00000001;
  private const int WHDR_PREPARED = 0x00000002;
  private const int MMSYSERR_NOERROR = 0;
  private const int MAX_BUFFERS = 4;
  private const int BUFFER_BYTES = 4800; // 100ms @ 24kHz mono 16-bit

  [DllImport("winmm.dll")]
  private static extern int waveOutOpen(out IntPtr hWaveOut, int uDeviceID, WaveFormat lpFormat, IntPtr dwCallback, IntPtr dwInstance, int dwFlags);
  [DllImport("winmm.dll")]
  private static extern int waveOutPrepareHeader(IntPtr hWaveOut, IntPtr lpWaveOutHdr, int uSize);
  [DllImport("winmm.dll")]
  private static extern int waveOutUnprepareHeader(IntPtr hWaveOut, IntPtr lpWaveOutHdr, int uSize);
  [DllImport("winmm.dll")]
  private static extern int waveOutWrite(IntPtr hWaveOut, IntPtr lpWaveOutHdr, int uSize);
  [DllImport("winmm.dll")]
  private static extern int waveOutReset(IntPtr hWaveOut);
  [DllImport("winmm.dll")]
  private static extern int waveOutClose(IntPtr hWaveOut);

  private readonly object _gate = new object();
  private readonly Queue<byte[]> _queue = new Queue<byte[]>();
  private readonly List<byte> _carry = new List<byte>(BUFFER_BYTES * 2);
  private IntPtr _hWaveOut = IntPtr.Zero;
  private WaveHdr[] _hdrs;
  private IntPtr[] _hdrPtrs;
  private GCHandle[] _dataPins;
  private bool[] _inFlight;
  private Thread _thread;
  private volatile bool _ending;
  private volatile bool _stopThread;
  private ManualResetEventSlim _wake = new ManualResetEventSlim(false);
  private int _bytesQueued;
  private int _bytesWritten;
  private bool _startedPlay;
  private DateTime _t0;
  private int? _firstMs;
  private string _error;

  public int BytesQueued { get { return _bytesQueued; } }
  public int? FirstMs { get { return _firstMs; } }
  public string Error { get { return _error; } }
  public bool StartedPlay { get { return _startedPlay; } }

  public void Start(int sampleRate, short channels, short bitsPerSample) {
    DisposePlayer();
    _ending = false;
    _stopThread = false;
    _bytesQueued = 0;
    _bytesWritten = 0;
    _startedPlay = false;
    _firstMs = null;
    _error = null;
    _t0 = DateTime.UtcNow;
    _carry.Clear();
    _queue.Clear();

    var fmt = new WaveFormat();
    fmt.wFormatTag = 1; // PCM
    fmt.nChannels = channels;
    fmt.nSamplesPerSec = sampleRate;
    fmt.wBitsPerSample = bitsPerSample;
    fmt.nBlockAlign = (short)(channels * bitsPerSample / 8);
    fmt.nAvgBytesPerSec = sampleRate * fmt.nBlockAlign;
    fmt.cbSize = 0;

    int rc = waveOutOpen(out _hWaveOut, WAVE_MAPPER, fmt, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL);
    if (rc != MMSYSERR_NOERROR) {
      throw new Exception("waveOutOpen failed: " + rc);
    }

    _hdrs = new WaveHdr[MAX_BUFFERS];
    _hdrPtrs = new IntPtr[MAX_BUFFERS];
    _dataPins = new GCHandle[MAX_BUFFERS];
    _inFlight = new bool[MAX_BUFFERS];
    int hdrSize = Marshal.SizeOf(typeof(WaveHdr));
    for (int i = 0; i < MAX_BUFFERS; i++) {
      _hdrs[i] = new WaveHdr();
      _hdrPtrs[i] = Marshal.AllocHGlobal(hdrSize);
      byte[] blank = new byte[BUFFER_BYTES];
      _dataPins[i] = GCHandle.Alloc(blank, GCHandleType.Pinned);
      _hdrs[i].lpData = _dataPins[i].AddrOfPinnedObject();
      _hdrs[i].dwBufferLength = BUFFER_BYTES;
      _hdrs[i].dwFlags = 0;
      Marshal.StructureToPtr(_hdrs[i], _hdrPtrs[i], false);
      rc = waveOutPrepareHeader(_hWaveOut, _hdrPtrs[i], hdrSize);
      if (rc != MMSYSERR_NOERROR) {
        throw new Exception("waveOutPrepareHeader failed: " + rc);
      }
      // Mark as free (DONE) initially so we can fill them.
      _hdrs[i].dwFlags = WHDR_DONE | WHDR_PREPARED;
      Marshal.StructureToPtr(_hdrs[i], _hdrPtrs[i], false);
      _inFlight[i] = false;
    }

    _thread = new Thread(PlayerLoop);
    _thread.IsBackground = true;
    _thread.Start();
  }

  public void Write(byte[] pcm) {
    if (pcm == null || pcm.Length == 0) return;
    lock (_gate) {
      _queue.Enqueue(pcm);
      _bytesQueued += pcm.Length;
    }
    _wake.Set();
  }

  public int EndAndWait(int timeoutMs) {
    _ending = true;
    _wake.Set();
    if (_thread != null) {
      if (!_thread.Join(timeoutMs)) {
        _stopThread = true;
        _wake.Set();
        _thread.Join(2000);
        throw new Exception("PCM player drain timeout");
      }
    }
    if (_error != null) throw new Exception(_error);
    return _bytesWritten;
  }

  private void PlayerLoop() {
    try {
      int hdrSize = Marshal.SizeOf(typeof(WaveHdr));
      // Preroll ~100ms before first write to reduce underruns.
      int preroll = BUFFER_BYTES;
      while (!_stopThread) {
        ReapDone(hdrSize);

        bool canStart = _startedPlay || _bytesQueued >= preroll || _ending;
        if (canStart) {
          for (int i = 0; i < MAX_BUFFERS; i++) {
            if (_inFlight[i]) continue;
            byte[] chunk = TakeChunk(BUFFER_BYTES);
            if (chunk == null) break;
            WriteBuffer(i, chunk, hdrSize);
          }
        }

        bool anyInFlight = false;
        for (int i = 0; i < MAX_BUFFERS; i++) if (_inFlight[i]) { anyInFlight = true; break; }

        lock (_gate) {
          if (_ending && _queue.Count == 0 && _carry.Count == 0 && !anyInFlight) break;
        }

        _wake.Wait(20);
        _wake.Reset();
      }

      // Final reap
      int spins = 0;
      while (spins++ < 500) {
        ReapDone(hdrSize);
        bool any = false;
        for (int i = 0; i < MAX_BUFFERS; i++) if (_inFlight[i]) { any = true; break; }
        if (!any) break;
        Thread.Sleep(10);
      }
    } catch (Exception ex) {
      _error = ex.Message;
    } finally {
      SafeResetClose();
    }
  }

  private void ReapDone(int hdrSize) {
    for (int i = 0; i < MAX_BUFFERS; i++) {
      if (!_inFlight[i]) continue;
      WaveHdr hdr = (WaveHdr)Marshal.PtrToStructure(_hdrPtrs[i], typeof(WaveHdr));
      if ((hdr.dwFlags & WHDR_DONE) != 0) {
        _inFlight[i] = false;
        _hdrs[i] = hdr;
      }
    }
  }

  private byte[] TakeChunk(int want) {
    lock (_gate) {
      while (_carry.Count < want && _queue.Count > 0) {
        byte[] next = _queue.Dequeue();
        _carry.AddRange(next);
      }
      if (_carry.Count == 0) return null;
      // If ending, flush whatever remains (even odd length trimmed).
      int take = want;
      if (_carry.Count < want) {
        if (!_ending) return null;
        take = _carry.Count;
      }
      if ((take % 2) == 1) take -= 1;
      if (take <= 0) {
        if (_ending) _carry.Clear();
        return null;
      }
      byte[] chunk = _carry.GetRange(0, take).ToArray();
      _carry.RemoveRange(0, take);
      return chunk;
    }
  }

  private void WriteBuffer(int index, byte[] chunk, int hdrSize) {
    // Replace pinned buffer contents (may be shorter than BUFFER_BYTES on final).
    byte[] buf = (byte[])_dataPins[index].Target;
    if (chunk.Length > buf.Length) {
      // Re-pin larger buffer (rare).
      waveOutUnprepareHeader(_hWaveOut, _hdrPtrs[index], hdrSize);
      _dataPins[index].Free();
      buf = new byte[chunk.Length];
      _dataPins[index] = GCHandle.Alloc(buf, GCHandleType.Pinned);
      _hdrs[index].lpData = _dataPins[index].AddrOfPinnedObject();
      int rcPrep = waveOutPrepareHeader(_hWaveOut, _hdrPtrs[index], hdrSize);
      if (rcPrep != MMSYSERR_NOERROR) throw new Exception("waveOutPrepareHeader resize failed: " + rcPrep);
    }
    Buffer.BlockCopy(chunk, 0, buf, 0, chunk.Length);
    _hdrs[index].lpData = _dataPins[index].AddrOfPinnedObject();
    _hdrs[index].dwBufferLength = chunk.Length;
    _hdrs[index].dwFlags = WHDR_PREPARED;
    Marshal.StructureToPtr(_hdrs[index], _hdrPtrs[index], false);

    int rc = waveOutWrite(_hWaveOut, _hdrPtrs[index], hdrSize);
    if (rc != MMSYSERR_NOERROR) {
      throw new Exception("waveOutWrite failed: " + rc);
    }
    _inFlight[index] = true;
    _bytesWritten += chunk.Length;
    if (!_startedPlay) {
      _startedPlay = true;
      _firstMs = (int)(DateTime.UtcNow - _t0).TotalMilliseconds;
    }
  }

  private void SafeResetClose() {
    try {
      if (_hWaveOut != IntPtr.Zero) waveOutReset(_hWaveOut);
    } catch { }
    int hdrSize = Marshal.SizeOf(typeof(WaveHdr));
    if (_hdrPtrs != null) {
      for (int i = 0; i < _hdrPtrs.Length; i++) {
        try {
          if (_hWaveOut != IntPtr.Zero && _hdrPtrs[i] != IntPtr.Zero) {
            waveOutUnprepareHeader(_hWaveOut, _hdrPtrs[i], hdrSize);
          }
        } catch { }
        try {
          if (_hdrPtrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(_hdrPtrs[i]);
        } catch { }
        try {
          if (_dataPins != null && _dataPins[i].IsAllocated) _dataPins[i].Free();
        } catch { }
      }
    }
    try {
      if (_hWaveOut != IntPtr.Zero) waveOutClose(_hWaveOut);
    } catch { }
    _hWaveOut = IntPtr.Zero;
    _hdrPtrs = null;
    _dataPins = null;
    _hdrs = null;
    _inFlight = null;
  }

  private void DisposePlayer() {
    _stopThread = true;
    _ending = true;
    _wake.Set();
    if (_thread != null) {
      try { _thread.Join(3000); } catch { }
      _thread = null;
    }
    SafeResetClose();
  }

  public void Dispose() {
    DisposePlayer();
    try { _wake.Dispose(); } catch { }
  }
}
"@

$player = $null

function Write-OkLine([string]$line) {
  Write-Output $line
  [Console]::Out.Flush()
}

Write-OkLine "ready"

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -eq "quit") { break }

  try {
    if ($line.StartsWith("start ")) {
      $parts = $line.Split(" ")
      if ($parts.Length -lt 4) { throw "usage: start <rate> <channels> <bits>" }
      $rate = [int]$parts[1]
      $ch = [int16]$parts[2]
      $bits = [int16]$parts[3]
      if ($null -ne $player) {
        try { $player.Dispose() } catch {}
        $player = $null
      }
      $player = New-Object VoiceCursorPcmPlayer
      $player.Start($rate, $ch, $bits)
      # no reply — wait for pcm/end; "first" is emitted from Node via polling... 
      # Emit nothing here; Node tracks first via our "first" line when play begins.
      continue
    }

    if ($line.StartsWith("pcm ")) {
      if ($null -eq $player) { throw "pcm before start" }
      $b64 = $line.Substring(4).Trim()
      if ([string]::IsNullOrWhiteSpace($b64)) { continue }
      $bytes = [Convert]::FromBase64String($b64)
      $already = $player.StartedPlay
      $player.Write($bytes)
      # Poll briefly so "first" can fire soon after preroll is met.
      if (-not $already) {
        for ($i = 0; $i -lt 30 -and -not $player.StartedPlay; $i++) {
          Start-Sleep -Milliseconds 5
        }
        if ($player.StartedPlay -and -not $already) {
          Write-OkLine ("first ms=" + $player.FirstMs)
        }
      }
      continue
    }

    if ($line -eq "end") {
      if ($null -eq $player) { throw "end before start" }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $wrote = $player.EndAndWait(120000)
      $first = $player.FirstMs
      if ($null -eq $first) { $first = -1 }
      $queued = $player.BytesQueued
      try { $player.Dispose() } catch {}
      $player = $null
      Write-OkLine ("ok bytes=" + $wrote + " queued=" + $queued + " firstMs=" + $first + " drainMs=" + $sw.ElapsedMilliseconds)
      continue
    }

    throw "unknown command"
  } catch {
    try { if ($null -ne $player) { $player.Dispose() } } catch {}
    $player = $null
    Write-OkLine ("err " + $_.Exception.Message)
  }
}

try { if ($null -ne $player) { $player.Dispose() } } catch {}
