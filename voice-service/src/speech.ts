import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const execFileAsync = promisify(execFile);

const DEFAULT_EDGE_VOICE = "en-PH-JamesNeural";

export function resolveRepoScript(name: string): string | undefined {
  const candidates = [
    path.resolve(__dirname, "..", "..", "scripts", name),
    path.resolve(process.cwd(), "scripts", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function describeSttConfig(): {
  engine: string;
  resolved: string;
} {
  return {
    engine: "windows",
    resolved: process.platform === "win32" ? "windows-system-speech" : "unsupported",
  };
}

export function describeTtsConfig(): {
  engine: string;
  voice: string;
} {
  const engine = (process.env.VOICE_CURSOR_TTS ?? "edge").toLowerCase();
  const voice = process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE;
  return { engine, voice };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function chunkForTts(text: string, maxChars = 900): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(". ", maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.4) cut = maxChars;
    chunks.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function listenOnce(options: {
  seconds?: number;
}): Promise<{ text: string; engine: string }> {
  const seconds = options.seconds ?? 7;

  if (process.platform !== "win32") {
    throw new Error(
      `STT is Windows System.Speech only for now (platform=${process.platform})`,
    );
  }

  const script = resolveRepoScript("stt-windows.ps1");
  if (!script) {
    throw new Error("scripts/stt-windows.ps1 not found");
  }

  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Seconds",
      String(seconds),
    ],
    {
      windowsHide: true,
      timeout: (seconds + 15) * 1000,
      maxBuffer: 1024 * 1024,
    },
  );

  const text = String(stdout ?? "").trim();
  if (!text && stderr?.trim()) {
    throw new Error(stderr.trim());
  }
  return { text, engine: "windows-system-speech" };
}

type MicSession = {
  id: string;
  wavPath: string;
  stopPath: string;
  child: ReturnType<typeof import("node:child_process").spawn>;
  startedAt: string;
};

let micSession: MicSession | null = null;

export function getMicSessionStatus(): {
  listening: boolean;
  id?: string;
  startedAt?: string;
} {
  if (!micSession) return { listening: false };
  return {
    listening: true,
    id: micSession.id,
    startedAt: micSession.startedAt,
  };
}

export async function startMicSession(options?: {
  maxSeconds?: number;
}): Promise<{ id: string; startedAt: string }> {
  if (process.platform !== "win32") {
    throw new Error("Push-to-talk mic recording is Windows-only for now");
  }
  if (micSession) {
    throw new Error("Already listening — stop the current session first");
  }

  const script = resolveRepoScript("record-until-stop-windows.ps1");
  if (!script) throw new Error("scripts/record-until-stop-windows.ps1 not found");

  const id = `mic-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-mic-"));
  const wavPath = path.join(dir, "clip.wav");
  const stopPath = path.join(dir, "stop.flag");
  const maxSeconds = options?.maxSeconds ?? 120;
  const startedAt = new Date().toISOString();

  const { spawn } = await import("node:child_process");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-OutFile",
      wavPath,
      "-StopFile",
      stopPath,
      "-MaxSeconds",
      String(maxSeconds),
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  micSession = { id, wavPath, stopPath, child, startedAt };

  child.on("exit", () => {
    // Session cleared on stop; if process dies early, mark inactive.
    if (micSession?.id === id) {
      // keep paths so stop can still try to read wav if process exited after save
    }
  });

  // Give MCI a moment to start recording.
  await new Promise((r) => setTimeout(r, 400));
  if (child.exitCode !== null) {
    micSession = null;
    throw new Error("Mic recorder exited immediately — check microphone permissions");
  }

  return { id, startedAt };
}

async function transcribeWav(wavPath: string): Promise<string> {
  const script = resolveRepoScript("stt-wav-windows.ps1");
  if (!script) throw new Error("scripts/stt-wav-windows.ps1 not found");
  const bytes = fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0;
  console.log(`[voice-cursor] transcribeWav start bytes=${bytes} path=${wavPath}`);
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-WavFile",
        wavPath,
        "-TimeoutSeconds",
        "20",
      ],
      {
        windowsHide: true,
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const lines = String(stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Last non-meta line is the transcript.
    const textLine =
      [...lines].reverse().find((l) => !l.startsWith("meta ")) ?? "";
    if (!textLine && stderr?.trim()) throw new Error(stderr.trim());
    console.log(
      `[voice-cursor] transcribeWav done ms=${Date.now() - started} text=${textLine || "(empty)"}`,
    );
    return textLine;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[voice-cursor] transcribeWav failed ms=${Date.now() - started}: ${message}`);
    throw new Error(`WAV transcription failed/timed out: ${message}`);
  }
}

export async function stopMicSessionAndTranscribe(): Promise<{
  text: string;
  engine: string;
  id: string;
  durationMs: number;
}> {
  if (!micSession) {
    throw new Error("Not listening — start listening first");
  }

  const session = micSession;
  const started = Date.parse(session.startedAt);
  console.log(`[voice-cursor] mic stop requested id=${session.id}`);
  try {
    fs.writeFileSync(session.stopPath, "stop\n", "utf8");
  } catch (error) {
    console.warn("[voice-cursor] could not write stop file", error);
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[voice-cursor] mic recorder exit wait timed out; killing");
      resolve();
    }, 8_000);
    if (session.child.exitCode !== null) {
      clearTimeout(timeout);
      resolve();
      return;
    }
    session.child.once("exit", (code) => {
      console.log(`[voice-cursor] mic recorder exited code=${code}`);
      clearTimeout(timeout);
      resolve();
    });
  });

  try {
    session.child.kill();
  } catch {
    // ignore
  }

  micSession = null;

  // Brief settle for file flush.
  await new Promise((r) => setTimeout(r, 200));

  if (!fs.existsSync(session.wavPath)) {
    throw new Error("Recording stopped but WAV was not created");
  }
  const bytes = fs.statSync(session.wavPath).size;
  console.log(`[voice-cursor] mic wav ready bytes=${bytes}`);
  if (bytes < 1000) {
    try {
      fs.rmSync(path.dirname(session.wavPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw new Error(`Recording too short/empty (${bytes} bytes)`);
  }

  try {
    const text = await transcribeWav(session.wavPath);
    return {
      text,
      engine: "windows-system-speech-wav",
      id: session.id,
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      fs.rmSync(path.dirname(session.wavPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function cancelMicSession(): Promise<void> {
  if (!micSession) return;
  const session = micSession;
  try {
    fs.writeFileSync(session.stopPath, "stop\n", "utf8");
  } catch {
    // ignore
  }
  try {
    session.child.kill();
  } catch {
    // ignore
  }
  micSession = null;
  try {
    fs.rmSync(path.dirname(session.wavPath), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function playAudioFile(filePath: string): Promise<void> {
  const stat = fs.statSync(filePath);
  if (stat.size < 500) {
    throw new Error(`Generated audio too small (${stat.size} bytes): ${filePath}`);
  }

  if (process.platform === "win32") {
    const script = resolveRepoScript("play-audio-windows.ps1");
    if (!script) throw new Error("scripts/play-audio-windows.ps1 not found");
    const playStarted = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Path",
          filePath,
        ],
        {
          windowsHide: true,
          timeout: 10 * 60 * 1000,
          maxBuffer: 1024 * 1024,
        },
      );
      const detail = `${stdout} ${stderr}`.trim();
      if (!/ok /i.test(detail)) {
        throw new Error(`Playback did not confirm success: ${detail || "(empty output)"}`);
      }
      console.log(
        `[voice-cursor] playback ${detail} wallMs=${Date.now() - playStarted}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Audio playback failed: ${message}`);
    }
    return;
  }

  if (process.platform === "darwin") {
    await execFileAsync("afplay", [filePath], { timeout: 10 * 60 * 1000 });
    return;
  }

  try {
    await execFileAsync("ffplay", ["-nodisp", "-autoexit", filePath], {
      timeout: 10 * 60 * 1000,
    });
  } catch {
    throw new Error("Could not play audio (install ffplay or use Windows/macOS)");
  }
}

type EdgeClientCache = { voice: string; tts: MsEdgeTTS };
let edgeClientCache: EdgeClientCache | null = null;

async function getEdgeClient(voice: string): Promise<MsEdgeTTS> {
  if (edgeClientCache?.voice === voice) return edgeClientCache.tts;
  const started = Date.now();
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  edgeClientCache = { voice, tts };
  console.log(
    `[voice-cursor] edge-tts metadata ready voice=${voice} ms=${Date.now() - started}`,
  );
  return tts;
}

/** Optional warm-up so the first spoken reply is faster. */
export async function warmTts(): Promise<void> {
  const preferred = (process.env.VOICE_CURSOR_TTS ?? "edge").toLowerCase();
  if (preferred === "windows") return;
  const voice = process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE;
  try {
    await getEdgeClient(voice);
  } catch (error) {
    console.warn(
      "[voice-cursor] TTS warm-up failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function speakWithEdge(text: string): Promise<{ engine: string; voice: string }> {
  const voice = process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE;
  const totalStarted = Date.now();
  const tts = await getEdgeClient(voice);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-tts-"));
  try {
    for (const chunk of chunkForTts(text)) {
      const synthStarted = Date.now();
      // msedge-tts injects this string into SSML — escape XML specials.
      const { audioFilePath } = await tts.toFile(tmpDir, escapeXml(chunk));
      const synthMs = Date.now() - synthStarted;
      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Edge TTS did not write audio file for voice=${voice}`);
      }
      const bytes = fs.statSync(audioFilePath).size;
      console.log(
        `[voice-cursor] edge-tts wrote ${audioFilePath} (${bytes} bytes) voice=${voice} synthMs=${synthMs}`,
      );
      await playAudioFile(audioFilePath);
      try {
        fs.unlinkSync(audioFilePath);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log(`[voice-cursor] edge-tts totalMs=${Date.now() - totalStarted}`);
  return { engine: "edge-tts", voice };
}

async function speakWithWindowsSapi(text: string): Promise<{ engine: string }> {
  const script = resolveRepoScript("tts-windows.ps1");
  if (!script) {
    throw new Error("scripts/tts-windows.ps1 not found");
  }
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Text", text],
    {
      windowsHide: true,
      timeout: Math.max(30_000, text.length * 80),
      maxBuffer: 1024 * 1024,
    },
  );
  return { engine: "windows-sapi" };
}

export async function speakText(text: string): Promise<{ engine: string; voice?: string }> {
  const cleaned = text.trim();
  if (!cleaned) return { engine: "none" };

  const preferred = (process.env.VOICE_CURSOR_TTS ?? "edge").toLowerCase();

  if (preferred === "windows") {
    if (process.platform !== "win32") {
      throw new Error("VOICE_CURSOR_TTS=windows is only supported on Windows");
    }
    return speakWithWindowsSapi(cleaned);
  }

  try {
    return await speakWithEdge(cleaned);
  } catch (error) {
    console.warn(
      "[voice-cursor] Edge TTS failed, falling back to Windows SAPI:",
      error instanceof Error ? error.message : error,
    );
    if (process.platform === "win32") {
      const result = await speakWithWindowsSapi(cleaned);
      return result;
    }
    throw error;
  }
}
