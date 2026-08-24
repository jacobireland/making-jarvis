import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from "msedge-tts";

const execFileAsync = promisify(execFile);

const DEFAULT_EDGE_VOICE = "en-PH-JamesNeural";
/** Default ~25% faster than Edge's natural rate — snappier agent replies. */
const DEFAULT_EDGE_RATE = 1.25;

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

export function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
    break;
  }
}

function openaiKey(): string | undefined {
  return (
    process.env.VOICE_CURSOR_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    undefined
  );
}

export function describeSttConfig(): {
  engine: string;
  resolved: string;
  hasOpenAI: boolean;
} {
  const preferred = (process.env.VOICE_CURSOR_STT ?? "auto").toLowerCase();
  const hasOpenAI = Boolean(openaiKey());
  let resolved = "windows-system-speech";
  if (preferred === "openai" || preferred === "whisper-openai") {
    resolved = hasOpenAI ? "whisper-openai" : "openai-missing-key";
  } else if (preferred === "auto" && hasOpenAI) {
    resolved = "whisper-openai";
  } else if (preferred === "windows") {
    resolved = "windows-system-speech";
  }
  return { engine: preferred, resolved, hasOpenAI };
}

function resolveTtsRate(): number | string {
  const raw = (process.env.VOICE_CURSOR_TTS_RATE ?? String(DEFAULT_EDGE_RATE)).trim();
  if (!raw) return DEFAULT_EDGE_RATE;
  // Allow SSML relative forms: "+20%", "fast", "1.25"
  if (/^[a-z-]+$/i.test(raw) || raw.includes("%")) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EDGE_RATE;
  // Clamp to a usable speaking range.
  return Math.min(2, Math.max(0.5, n));
}

export function describeTtsConfig(): {
  engine: string;
  voice: string;
  rate: number | string;
} {
  const engine = (process.env.VOICE_CURSOR_TTS ?? "edge").toLowerCase();
  const voice = process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE;
  return { engine, voice, rate: resolveTtsRate() };
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
  logPath: string;
  errPath: string;
  child: ReturnType<typeof import("node:child_process").spawn>;
  startedAt: string;
  stdout: string;
  stderr: string;
};

let micSession: MicSession | null = null;

function readTextIfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function micFailureDetail(session: MicSession, fallback: string): string {
  const errFile = readTextIfExists(session.errPath);
  const logTail = readTextIfExists(session.logPath).split(/\r?\n/).slice(-8).join(" | ");
  const stderr = session.stderr.trim().slice(-500);
  const stdout = session.stdout.trim().slice(-300);
  const bits = [
    fallback,
    errFile && `recorder: ${errFile}`,
    stderr && `stderr: ${stderr}`,
    stdout && `stdout: ${stdout}`,
    logTail && `log: ${logTail}`,
    `exit=${session.child.exitCode}`,
  ].filter(Boolean);
  return bits.join(" — ");
}

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
  const logPath = `${wavPath}.log`;
  const errPath = `${wavPath}.err`;
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

  const session: MicSession = {
    id,
    wavPath,
    stopPath,
    logPath,
    errPath,
    child,
    startedAt,
    stdout: "",
    stderr: "",
  };
  micSession = session;

  child.stdout?.on("data", (chunk: Buffer | string) => {
    session.stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    session.stderr += String(chunk);
    console.warn(`[voice-cursor] mic recorder stderr: ${String(chunk).trim()}`);
  });
  child.on("exit", (code) => {
    console.log(
      `[voice-cursor] mic recorder process exit code=${code} id=${id} stderr=${session.stderr.trim().slice(0, 200)}`,
    );
  });

  // Give MCI a moment to start recording.
  await new Promise((r) => setTimeout(r, 700));
  if (child.exitCode !== null) {
    micSession = null;
    throw new Error(
      micFailureDetail(
        session,
        "Mic recorder exited immediately — check Windows mic privacy settings (Settings → Privacy → Microphone)",
      ),
    );
  }

  console.log(`[voice-cursor] mic listening id=${id} wav=${wavPath}`);
  return { id, startedAt };
}

async function transcribeWavOpenAI(wavPath: string): Promise<string> {
  const key = openaiKey();
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const model = process.env.VOICE_CURSOR_WHISPER_MODEL || "whisper-1";
  const bytes = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI Whisper HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const parsed = JSON.parse(raw) as { text?: string };
  return (parsed.text ?? "").trim();
}

async function transcribeWavWindows(wavPath: string): Promise<string> {
  const script = resolveRepoScript("stt-wav-windows.ps1");
  if (!script) throw new Error("scripts/stt-wav-windows.ps1 not found");
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
  const textLine = [...lines].reverse().find((l) => !l.startsWith("meta ")) ?? "";
  if (!textLine && stderr?.trim()) throw new Error(stderr.trim());
  return textLine;
}

async function transcribeWav(wavPath: string): Promise<{ text: string; engine: string }> {
  const bytes = fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0;
  console.log(`[voice-cursor] transcribeWav start bytes=${bytes} path=${wavPath}`);
  const started = Date.now();
  const cfg = describeSttConfig();

  const tryOpenAI = cfg.resolved === "whisper-openai" || cfg.hasOpenAI;

  if (tryOpenAI && openaiKey()) {
    try {
      const text = await transcribeWavOpenAI(wavPath);
      console.log(
        `[voice-cursor] transcribeWav openai done ms=${Date.now() - started} text=${text || "(empty)"}`,
      );
      return { text, engine: "whisper-openai" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[voice-cursor] OpenAI Whisper failed: ${message}`);
      if ((process.env.VOICE_CURSOR_STT ?? "auto").toLowerCase().includes("openai")) {
        throw new Error(`OpenAI Whisper failed: ${message}`);
      }
      console.warn("[voice-cursor] falling back to Windows STT");
    }
  }

  try {
    const text = await transcribeWavWindows(wavPath);
    console.log(
      `[voice-cursor] transcribeWav windows done ms=${Date.now() - started} text=${text || "(empty)"}`,
    );
    return { text, engine: "windows-system-speech-wav" };
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
  const alreadyExited = session.child.exitCode !== null;
  console.log(
    `[voice-cursor] mic stop requested id=${session.id} alreadyExited=${alreadyExited} exit=${session.child.exitCode}`,
  );
  try {
    fs.writeFileSync(session.stopPath, "stop\n", "utf8");
  } catch (error) {
    console.warn("[voice-cursor] could not write stop file", error);
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[voice-cursor] mic recorder exit wait timed out; killing");
      resolve();
    }, 12_000);
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

  if (session.child.exitCode === null) {
    try {
      session.child.kill();
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  micSession = null;

  // Poll briefly for WAV flush (MCI save can lag a beat after process exit).
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(session.wavPath) && fs.statSync(session.wavPath).size > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!fs.existsSync(session.wavPath)) {
    const detail = micFailureDetail(
      session,
      alreadyExited
        ? "Recorder died before Stop (no WAV)"
        : "Recording stopped but WAV was not created",
    );
    try {
      fs.rmSync(path.dirname(session.wavPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  const bytes = fs.statSync(session.wavPath).size;
  console.log(`[voice-cursor] mic wav ready bytes=${bytes}`);
  if (bytes < 1000) {
    try {
      fs.rmSync(path.dirname(session.wavPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw new Error(
      micFailureDetail(session, `Recording too short/empty (${bytes} bytes)`),
    );
  }

  try {
    const result = await transcribeWav(session.wavPath);
    return {
      text: result.text,
      engine: result.engine,
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
  const rate = resolveTtsRate();
  const totalStarted = Date.now();
  const tts = await getEdgeClient(voice);
  const prosody = new ProsodyOptions();
  prosody.rate = rate;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-tts-"));
  try {
    for (const chunk of chunkForTts(text)) {
      const synthStarted = Date.now();
      // msedge-tts injects this string into SSML — escape XML specials.
      const { audioFilePath } = await tts.toFile(tmpDir, escapeXml(chunk), prosody);
      const synthMs = Date.now() - synthStarted;
      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Edge TTS did not write audio file for voice=${voice}`);
      }
      const bytes = fs.statSync(audioFilePath).size;
      console.log(
        `[voice-cursor] edge-tts wrote ${audioFilePath} (${bytes} bytes) voice=${voice} rate=${rate} synthMs=${synthMs}`,
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
