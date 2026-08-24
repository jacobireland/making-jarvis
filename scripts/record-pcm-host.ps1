# Stream microphone PCM (linear16) to stdout until stdin "stop".
# Node protocol:
#   Host → ready
#   Host → pcm <base64>     (≈80ms frames)
#   Host → ok bytes=N
#   Host → err <message>
#   Node → stop | quit
#
# Usage:
#   powershell ... -File record-pcm-host.ps1 -SampleRate 16000 -Channels 1 -Bits 16

param(
  [int]$SampleRate = 16000,
  [int]$Channels = 1,
  [int]$Bits = 16
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class VoiceCursorPcmRecorder : IDisposable {
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
  private const int MAX_BUFFERS = 8;

  [DllImport("winmm.dll")]
  private static extern int waveInOpen(out IntPtr hWaveIn, int uDeviceID, WaveFormat lpFormat, IntPtr dwCallback, IntPtr dwInstance, int dwFlags);
  [DllImport("winmm.dll")]
  private static extern int waveInPrepareHeader(IntPtr hWaveIn, IntPtr lpWaveInHdr, int uSize);
  [DllImport("winmm.dll")]
  private static extern int waveInUnprepareHeader(IntPtr hWaveIn, IntPtr lpWaveInHdr, int uSize);
  [DllImport("winmm.dll")]
  private static extern int waveInAddBuffer(IntPtr hWaveIn, IntPtr lpWaveInHdr, int uSize);
  [DllImport("winmm.dll")]
  private static extern int waveInStart(IntPtr hWaveIn);
  [DllImport("winmm.dll")]
  private static extern int waveInStop(IntPtr hWaveIn);
  [DllImport("winmm.dll")]
  private static extern int waveInReset(IntPtr hWaveIn);
  [DllImport("winmm.dll")]
  private static extern int waveInClose(IntPtr hWaveIn);

  private readonly object _gate = new object();
  private IntPtr _hWaveIn = IntPtr.Zero;
  private WaveHdr[] _hdrs;
  private IntPtr[] _hdrPtrs;
  private GCHandle[] _dataPins;
  private Thread _thread;
  private volatile bool _stopThread;
  private ManualResetEventSlim _wake = new ManualResetEventSlim(false);
  private int _bytesCaptured;
  private int _bufferBytes;
  private volatile bool _emit;
  private string _error;

  public int BytesCaptured { get { return _bytesCaptured; } }
  public string Error { get { return _error; } }

  public void Start(int sampleRate, short channels, short bitsPerSample, int bufferBytes) {
    DisposeRecorder();
    _stopThread = false;
    _emit = true;
    _bytesCaptured = 0;
    _error = null;
    _bufferBytes = bufferBytes < 320 ? 320 : bufferBytes;

    var fmt = new WaveFormat();
    fmt.wFormatTag = 1;
    fmt.nChannels = channels;
    fmt.nSamplesPerSec = sampleRate;
    fmt.wBitsPerSample = bitsPerSample;
    fmt.nBlockAlign = (short)(channels * bitsPerSample / 8);
    fmt.nAvgBytesPerSec = sampleRate * fmt.nBlockAlign;
    fmt.cbSize = 0;

    int rc = waveInOpen(out _hWaveIn, WAVE_MAPPER, fmt, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL);
    if (rc != MMSYSERR_NOERROR) {
      throw new Exception("waveInOpen failed: " + rc + " — check Windows mic privacy settings");
    }

    _hdrs = new WaveHdr[MAX_BUFFERS];
    _hdrPtrs = new IntPtr[MAX_BUFFERS];
    _dataPins = new GCHandle[MAX_BUFFERS];
    int hdrSize = Marshal.SizeOf(typeof(WaveHdr));
    for (int i = 0; i < MAX_BUFFERS; i++) {
      _hdrs[i] = new WaveHdr();
      _hdrPtrs[i] = Marshal.AllocHGlobal(hdrSize);
      byte[] blank = new byte[_bufferBytes];
      _dataPins[i] = GCHandle.Alloc(blank, GCHandleType.Pinned);
      _hdrs[i].lpData = _dataPins[i].AddrOfPinnedObject();
      _hdrs[i].dwBufferLength = _bufferBytes;
      _hdrs[i].dwFlags = 0;
      Marshal.StructureToPtr(_hdrs[i], _hdrPtrs[i], false);
      rc = waveInPrepareHeader(_hWaveIn, _hdrPtrs[i], hdrSize);
      if (rc != MMSYSERR_NOERROR) throw new Exception("waveInPrepareHeader failed: " + rc);
      rc = waveInAddBuffer(_hWaveIn, _hdrPtrs[i], hdrSize);
      if (rc != MMSYSERR_NOERROR) throw new Exception("waveInAddBuffer failed: " + rc);
    }

    rc = waveInStart(_hWaveIn);
    if (rc != MMSYSERR_NOERROR) throw new Exception("waveInStart failed: " + rc);

    _thread = new Thread(CaptureLoop);
    _thread.IsBackground = true;
    _thread.Start();
  }

  public void StopEmitting() {
    _emit = false;
  }

  public void Stop() {
    _emit = false;
    _stopThread = true;
    _wake.Set();
    if (_thread != null) {
      try { _thread.Join(4000); } catch { }
      _thread = null;
    }
    DisposeRecorder();
  }

  private void CaptureLoop() {
    try {
      int hdrSize = Marshal.SizeOf(typeof(WaveHdr));
      while (!_stopThread) {
        ReapDone(hdrSize);
        _wake.Wait(15);
        _wake.Reset();
      }
      try { waveInStop(_hWaveIn); } catch { }
      try { waveInReset(_hWaveIn); } catch { }
      ReapDone(hdrSize);
    } catch (Exception ex) {
      _error = ex.Message;
    }
  }

  private void ReapDone(int hdrSize) {
    if (_hdrPtrs == null) return;
    for (int i = 0; i < _hdrPtrs.Length; i++) {
      WaveHdr hdr = (WaveHdr)Marshal.PtrToStructure(_hdrPtrs[i], typeof(WaveHdr));
      if ((hdr.dwFlags & WHDR_DONE) == 0) continue;
      int n = hdr.dwBytesRecorded;
      if (n > 0) {
        byte[] src = (byte[])_dataPins[i].Target;
        if (n > src.Length) n = src.Length;
        _bytesCaptured += n;
        if (_emit) {
          try {
            byte[] copy = new byte[n];
            Buffer.BlockCopy(src, 0, copy, 0, n);
            string line = "pcm " + Convert.ToBase64String(copy);
            lock (_gate) {
              Console.Out.WriteLine(line);
              Console.Out.Flush();
            }
          } catch { }
        }
      }
      hdr.dwBytesRecorded = 0;
      hdr.dwFlags = WHDR_PREPARED;
      Marshal.StructureToPtr(hdr, _hdrPtrs[i], false);
      if (!_stopThread && _hWaveIn != IntPtr.Zero) {
        int rc = waveInAddBuffer(_hWaveIn, _hdrPtrs[i], hdrSize);
        if (rc != MMSYSERR_NOERROR) {
          _error = "waveInAddBuffer reuse failed: " + rc;
          _stopThread = true;
        }
      }
    }
  }

  private void DisposeRecorder() {
    _stopThread = true;
    _wake.Set();
    if (_thread != null) {
      try { _thread.Join(2000); } catch { }
      _thread = null;
    }
    try { if (_hWaveIn != IntPtr.Zero) waveInReset(_hWaveIn); } catch { }
    int hdrSize = Marshal.SizeOf(typeof(WaveHdr));
    if (_hdrPtrs != null) {
      for (int i = 0; i < _hdrPtrs.Length; i++) {
        try {
          if (_hWaveIn != IntPtr.Zero && _hdrPtrs[i] != IntPtr.Zero) {
            waveInUnprepareHeader(_hWaveIn, _hdrPtrs[i], hdrSize);
          }
        } catch { }
        try { if (_hdrPtrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(_hdrPtrs[i]); } catch { }
        try { if (_dataPins != null && _dataPins[i].IsAllocated) _dataPins[i].Free(); } catch { }
      }
    }
    try { if (_hWaveIn != IntPtr.Zero) waveInClose(_hWaveIn); } catch { }
    _hWaveIn = IntPtr.Zero;
    _hdrPtrs = null;
    _dataPins = null;
    _hdrs = null;
  }

  public void Dispose() {
    DisposeRecorder();
    try { _wake.Dispose(); } catch { }
  }
}
"@

function Write-OkLine([string]$line) {
  Write-Output $line
  [Console]::Out.Flush()
}

$rec = $null

try {
  $blockAlign = [int]($Channels * $Bits / 8)
  if ($blockAlign -lt 1) { $blockAlign = 2 }
  # ~80ms frames (Deepgram Flux recommendation).
  $bufferBytes = [int]($SampleRate * $blockAlign * 80 / 1000)
  if ($bufferBytes -lt 320) { $bufferBytes = 320 }
  if (($bufferBytes % 2) -eq 1) { $bufferBytes -= 1 }

  $rec = New-Object VoiceCursorPcmRecorder
  $rec.Start($SampleRate, [int16]$Channels, [int16]$Bits, $bufferBytes)
  Write-OkLine "ready"

  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -eq "stop" -or $line -eq "quit") { break }
  }

  if ($null -ne $rec) {
    try { $rec.StopEmitting() } catch {}
    $err = $rec.Error
    $bytes = $rec.BytesCaptured
    try { $rec.Stop() } catch {}
    try { $rec.Dispose() } catch {}
    $rec = $null
    if ($err) { throw $err }
    Write-OkLine ("ok bytes=" + $bytes)
  }
} catch {
  try { if ($null -ne $rec) { $rec.Stop() } } catch {}
  try { if ($null -ne $rec) { $rec.Dispose() } } catch {}
  Write-OkLine ("err " + $_.Exception.Message)
  exit 1
}
