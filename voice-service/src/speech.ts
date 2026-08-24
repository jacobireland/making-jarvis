import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from "msedge-tts";
import {
  FluxTtsSession,
  FLUX_TTS_SAMPLE_RATE,
  writePcmWavFile,
} from "./flux-tts";
import {
  FluxSttSession,
  FLUX_STT_SAMPLE_RATE,
  DEFAULT_FLUX_STT_MODEL,
  shouldCommitFluxTurn,
  resolveEotThreshold,
  resolveEotTimeoutMs,
} from "./flux-stt";

const execFileAsync = promisify(execFile);

const DEFAULT_EDGE_VOICE = "en-PH-JamesNeural";
/** Default ~25% faster than Edge's natural rate — snappier agent replies. */
const DEFAULT_EDGE_RATE = 1.25;
const DEFAULT_DEEPGRAM_STT_MODEL = "nova-3";
/** Flux Marcelo (v2/speak). Override with VOICE_CURSOR_TTS_VOICE. */
const DEFAULT_DEEPGRAM_TTS_MODEL = "flux-marcelo-en";
/** Flux allows discrete speeds; 1.1 matches the user's preferred cadence. */
const DEFAULT_DEEPGRAM_TTS_SPEED = 1.1;
const FLUX_TTS_SPEEDS = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15] as const;

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
    console.log(`[voice-cursor] loaded env from ${file}`);
    break;
  }
}

function openaiKey(): string | undefined {
  return sanitizeSecret(
    process.env.VOICE_CURSOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  );
}

function deepgramKey(): string | undefined {
  const raw = sanitizeSecret(
    process.env.VOICE_CURSOR_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY,
  );
  if (!raw) return undefined;
  // Users sometimes paste "Token xyz" from docs.
  const cleaned = raw.replace(/^(Token|Bearer)\s+/i, "").trim();
  if (!cleaned) return undefined;
  // Placeholder values from .env.example
  if (
    cleaned === "..." ||
    /^your[-_]?key/i.test(cleaned) ||
    cleaned.includes("sk-...") ||
    cleaned.length < 16
  ) {
    console.warn(
      `[voice-cursor] DEEPGRAM_API_KEY looks like a placeholder (len=${cleaned.length}) — create a real key at https://console.deepgram.com/`,
    );
    return undefined;
  }
  return cleaned;
}

function sanitizeSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function describeSecret(value: string | undefined): string {
  if (!value) return "missing";
  if (value.length < 8) return `len=${value.length}`;
  return `len=${value.length} tail=…${value.slice(-4)}`;
}

/** Safe startup hint — never prints the full API key. */
export function logAuthHints(): void {
  console.log(
    `[voice-cursor] auth deepgram=${describeSecret(deepgramKey())} openai=${describeSecret(openaiKey())}`,
  );
}

function isVadEnabled(): boolean {
  const raw = (process.env.VOICE_CURSOR_VAD ?? "true").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function isStreamListenEnabled(): boolean {
  const raw = (process.env.VOICE_CURSOR_STT_STREAM ?? "auto").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "wav") return false;
  return true;
}

function canStreamFluxStt(): boolean {
  if (process.platform !== "win32") return false;
  if (!deepgramKey()) return false;
  if (!isStreamListenEnabled()) return false;
  const preferred = (process.env.VOICE_CURSOR_STT ?? "auto").toLowerCase();
  if (preferred === "windows" || preferred === "openai" || preferred === "whisper-openai") {
    return false;
  }
  return true;
}

export function describeSttConfig(): {
  engine: string;
  resolved: string;
  hasOpenAI: boolean;
  hasDeepgram: boolean;
  vad: boolean;
  streamListen: boolean;
  eotThreshold?: number;
} {
  const preferred = (process.env.VOICE_CURSOR_STT ?? "auto").toLowerCase();
  const hasOpenAI = Boolean(openaiKey());
  const hasDeepgram = Boolean(deepgramKey());
  let resolved = "windows-system-speech";

  if (preferred === "deepgram") {
    resolved = hasDeepgram ? "deepgram" : "deepgram-missing-key";
  } else if (preferred === "openai" || preferred === "whisper-openai") {
    resolved = hasOpenAI ? "whisper-openai" : "openai-missing-key";
  } else if (preferred === "windows") {
    resolved = "windows-system-speech";
  } else if (preferred === "auto") {
    if (hasDeepgram) resolved = "deepgram";
    else if (hasOpenAI) resolved = "whisper-openai";
  }

  const streamListen = canStreamFluxStt();
  return {
    engine: preferred,
    resolved,
    hasOpenAI,
    hasDeepgram,
    vad: isVadEnabled() && streamListen,
    streamListen,
    eotThreshold: streamListen ? resolveEotThreshold() : undefined,
  };
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

function resolveDeepgramTtsModel(): string {
  const raw = (
    process.env.VOICE_CURSOR_DEEPGRAM_TTS_MODEL ||
    process.env.VOICE_CURSOR_TTS_VOICE ||
    DEFAULT_DEEPGRAM_TTS_MODEL
  ).trim();
  // Ignore leftover Edge neural voice names if switching to Deepgram.
  if (/neural/i.test(raw)) return DEFAULT_DEEPGRAM_TTS_MODEL;
  const lower = raw.toLowerCase();
  if (lower.startsWith("flux-") || lower.startsWith("aura")) return raw;
  return DEFAULT_DEEPGRAM_TTS_MODEL;
}

function isFluxTtsModel(model: string): boolean {
  return model.toLowerCase().startsWith("flux-");
}

function snapFluxSpeed(value: number): number {
  let best: number = FLUX_TTS_SPEEDS[0];
  let bestDist = Math.abs(value - best);
  for (const candidate of FLUX_TTS_SPEEDS) {
    const dist = Math.abs(value - candidate);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

function resolveDeepgramTtsSpeed(): number {
  const raw = process.env.VOICE_CURSOR_TTS_RATE?.trim();
  let numeric: number | undefined;
  if (raw) {
    if (/^[a-z-]+$/i.test(raw)) {
      const map: Record<string, number> = {
        "x-slow": 0.85,
        slow: 0.9,
        medium: 1,
        default: 1,
        fast: 1.1,
        "x-fast": 1.15,
      };
      numeric = map[raw.toLowerCase()];
    } else if (raw.endsWith("%")) {
      const pct = Number(raw.replace("%", ""));
      if (Number.isFinite(pct)) numeric = 1 + pct / 100;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) numeric = n;
    }
  }
  const target = numeric ?? DEFAULT_DEEPGRAM_TTS_SPEED;
  const model = resolveDeepgramTtsModel();
  if (isFluxTtsModel(model)) return snapFluxSpeed(target);
  return Math.min(2, Math.max(0.5, target));
}

function resolveTtsStreamMode(): "auto" | "on" | "off" {
  const raw = (process.env.VOICE_CURSOR_TTS_STREAM ?? "auto").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "rest" || raw === "batch") {
    return "off";
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "ws" || raw === "stream") {
    return "on";
  }
  return "auto";
}

function shouldStreamDeepgramTts(model: string): boolean {
  const mode = resolveTtsStreamMode();
  if (mode === "off") return false;
  if (mode === "on") return isFluxTtsModel(model);
  // auto: stream Flux (low TTFA); Aura stays on REST mp3.
  return isFluxTtsModel(model);
}

export function describeTtsConfig(): {
  engine: string;
  resolved: string;
  voice: string;
  rate: number | string;
  hasDeepgram: boolean;
  stream: boolean;
} {
  const preferred = (process.env.VOICE_CURSOR_TTS ?? "auto").toLowerCase();
  const hasDeepgram = Boolean(deepgramKey());
  let resolved = "edge";
  if (preferred === "deepgram") {
    resolved = hasDeepgram ? "deepgram" : "deepgram-missing-key";
  } else if (preferred === "windows") {
    resolved = "windows";
  } else if (preferred === "edge") {
    resolved = "edge";
  } else if (preferred === "auto") {
    resolved = hasDeepgram ? "deepgram" : "edge";
  }

  const voice =
    process.env.VOICE_CURSOR_DEEPGRAM_TTS_MODEL ||
    (resolved === "deepgram"
      ? resolveDeepgramTtsModel()
      : (process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE));

  // When resolved to deepgram, surface Flux/Aura model (not an Edge leftover).
  const displayVoice =
    resolved === "deepgram" ? resolveDeepgramTtsModel() : voice;

  return {
    engine: preferred,
    resolved,
    voice: displayVoice,
    rate: resolved === "deepgram" ? resolveDeepgramTtsSpeed() : resolveTtsRate(),
    hasDeepgram,
    stream:
      resolved === "deepgram" && shouldStreamDeepgramTts(resolveDeepgramTtsModel()),
  };
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
  if (!cleaned) return [];

  // Prefer sentence-sized chunks so the first audio can start sooner.
  const sentences =
    cleaned.match(/[^.!?…]+(?:[.!?…]["']?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [
      cleaned,
    ];

  const chunks: string[] = [];
  let buf = "";
  const firstMax = Math.min(220, maxChars);

  for (const sentence of sentences) {
    const limit = chunks.length === 0 && !buf ? firstMax : maxChars;
    if (!buf) {
      if (sentence.length <= limit) {
        buf = sentence;
      } else {
        // Hard-wrap a long sentence.
        let remaining = sentence;
        while (remaining.length > limit) {
          let cut = remaining.lastIndexOf(" ", limit);
          if (cut < limit * 0.4) cut = limit;
          chunks.push(remaining.slice(0, cut).trim());
          remaining = remaining.slice(cut).trim();
        }
        buf = remaining;
      }
      continue;
    }
    if (`${buf} ${sentence}`.length <= limit) {
      buf = `${buf} ${sentence}`;
    } else {
      chunks.push(buf);
      buf = sentence;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

type ChildProc = ReturnType<typeof import("node:child_process").spawn>;

type WavMicSession = {
  mode: "wav";
  id: string;
  wavPath: string;
  stopPath: string;
  logPath: string;
  errPath: string;
  child: ChildProc;
  startedAt: string;
  stdout: string;
  stderr: string;
  autoEnd: false;
};

type StreamMicSession = {
  mode: "flux-stream";
  id: string;
  startedAt: string;
  child: ChildProc;
  flux: FluxSttSession;
  lastText: string;
  committed: { text: string; engine: string; confidence?: number } | null;
  stopping: boolean;
  stdout: string;
  stderr: string;
  autoEnd: boolean;
  maxTimer?: ReturnType<typeof setTimeout>;
  onUtteranceEnd?: (result: {
    text: string;
    engine: string;
    confidence?: number;
  }) => void;
  onPartial?: (text: string) => void;
};

type MicSession = WavMicSession | StreamMicSession;

let micSession: MicSession | null = null;

function readTextIfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function micFailureDetail(session: WavMicSession, fallback: string): string {
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
  mode?: "wav" | "flux-stream";
  autoEnd?: boolean;
  committed?: boolean;
} {
  if (!micSession) return { listening: false };
  return {
    listening: true,
    id: micSession.id,
    startedAt: micSession.startedAt,
    mode: micSession.mode,
    autoEnd: micSession.autoEnd,
    committed: micSession.mode === "flux-stream" ? Boolean(micSession.committed) : false,
  };
}

export type StartMicResult = {
  id: string;
  startedAt: string;
  autoEnd: boolean;
  mode: "wav" | "flux-stream";
};

export type StartMicOptions = {
  maxSeconds?: number;
  autoEnd?: boolean;
  onPartial?: (text: string) => void;
  onUtteranceEnd?: (result: {
    text: string;
    engine: string;
    confidence?: number;
  }) => void;
};

export async function startMicSession(options?: StartMicOptions): Promise<StartMicResult> {
  if (process.platform !== "win32") {
    throw new Error("Push-to-talk mic recording is Windows-only for now");
  }
  if (micSession) {
    throw new Error("Already listening — stop the current session first");
  }

  const wantAutoEnd = options?.autoEnd !== false && isVadEnabled();
  if (wantAutoEnd && canStreamFluxStt()) {
    try {
      return await startFluxMicSession(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[voice-cursor] Flux listen unavailable, falling back to WAV PTT: ${message}`);
    }
  }
  return startWavMicSession(options);
}

async function startWavMicSession(options?: StartMicOptions): Promise<StartMicResult> {
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

  const session: WavMicSession = {
    mode: "wav",
    id,
    wavPath,
    stopPath,
    logPath,
    errPath,
    child,
    startedAt,
    stdout: "",
    stderr: "",
    autoEnd: false,
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

  console.log(`[voice-cursor] mic listening id=${id} wav=${wavPath} mode=wav`);
  return { id, startedAt, autoEnd: false, mode: "wav" };
}

async function startFluxMicSession(options?: StartMicOptions): Promise<StartMicResult> {
  const key = deepgramKey();
  if (!key) throw new Error("DEEPGRAM_API_KEY not set");

  const script = resolveRepoScript("record-pcm-host.ps1");
  if (!script) throw new Error("scripts/record-pcm-host.ps1 not found");

  const id = `mic-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const maxSeconds = options?.maxSeconds ?? 120;

  const session: StreamMicSession = {
    mode: "flux-stream",
    id,
    startedAt,
    child: null as unknown as ChildProc,
    flux: null as unknown as FluxSttSession,
    lastText: "",
    committed: null,
    stopping: false,
    stdout: "",
    stderr: "",
    autoEnd: true,
    onUtteranceEnd: options?.onUtteranceEnd,
    onPartial: options?.onPartial,
  };

  const commitTurn = (text: string, confidence?: number) => {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (session.committed || session.stopping) {
      if (!session.committed && cleaned) {
        session.committed = { text: cleaned, engine: "deepgram-flux", confidence };
      }
      return;
    }
    if (cleaned.length < 2) return;
    session.committed = { text: cleaned, engine: "deepgram-flux", confidence };
    console.log(
      `[voice-cursor] flux-stt EndOfTurn id=${id} chars=${cleaned.length} text=${cleaned.slice(0, 120)}`,
    );
    try {
      session.child.stdin?.write("stop\n");
    } catch {
      // ignore
    }
    void session.flux.close();
    session.onUtteranceEnd?.(session.committed);
  };

  const flux = new FluxSttSession({
    apiKey: key,
    model: process.env.VOICE_CURSOR_FLUX_STT_MODEL || DEFAULT_FLUX_STT_MODEL,
    eotThreshold: resolveEotThreshold(),
    eotTimeoutMs: resolveEotTimeoutMs(),
    handlers: {
      onTurn: (msg) => {
        const current = micSession;
        if (!current || current.mode !== "flux-stream" || current.id !== id) return;
        if (typeof msg.transcript === "string" && msg.transcript.trim()) {
          current.lastText = msg.transcript.replace(/\s+/g, " ").trim();
          if (msg.event === "Update" || msg.event === "StartOfTurn") {
            current.onPartial?.(current.lastText);
          }
        }
        if (shouldCommitFluxTurn(msg)) {
          commitTurn(msg.transcript ?? current.lastText, msg.end_of_turn_confidence);
        }
      },
      onError: (error) => {
        const current = micSession;
        if (!current || current.mode !== "flux-stream" || current.id !== id) return;
        console.warn(`[voice-cursor] flux-stt error id=${id}: ${error.message}`);
      },
    },
  });
  session.flux = flux;
  try {
    await flux.connect();
  } catch (error) {
    void flux.close();
    throw error;
  }

  const { spawn } = await import("node:child_process");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-SampleRate",
      String(FLUX_STT_SAMPLE_RATE),
      "-Channels",
      "1",
      "-Bits",
      "16",
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  session.child = child;

  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let readySettled = false;
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    readyResolve();
  };
  const failReady = (error: Error) => {
    if (readySettled) return;
    readySettled = true;
    readyReject(error);
  };

  let lineBuf = "";
  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "ready") {
      markReady();
      return;
    }
    if (trimmed.startsWith("pcm ")) {
      const b64 = trimmed.slice(4).trim();
      if (!b64 || session.committed || session.stopping) return;
      try {
        const pcm = Buffer.from(b64, "base64");
        session.flux.sendPcm(pcm);
      } catch (error) {
        console.warn(
          `[voice-cursor] flux-stt pcm decode failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (/^err\b/i.test(trimmed)) {
      failReady(new Error(trimmed));
      return;
    }
    if (/^ok\b/i.test(trimmed)) {
      session.stdout += `${trimmed}\n`;
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    lineBuf += String(chunk);
    let nl = lineBuf.indexOf("\n");
    while (nl >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      onLine(line.replace(/\r$/, ""));
      nl = lineBuf.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    session.stderr += String(chunk);
    console.warn(`[voice-cursor] pcm recorder stderr: ${String(chunk).trim()}`);
  });
  child.on("exit", (code) => {
    console.log(
      `[voice-cursor] pcm recorder exit code=${code} id=${id} stderr=${session.stderr.trim().slice(0, 200)}`,
    );
    if (!readySettled) {
      failReady(
        new Error(
          `PCM recorder exited before ready (code=${code}) ${session.stderr.trim().slice(0, 200)}`,
        ),
      );
    }
  });

  const readyTimeout = setTimeout(() => {
    failReady(new Error("PCM recorder ready timeout"));
  }, 8000);

  try {
    await ready;
  } catch (error) {
    clearTimeout(readyTimeout);
    try {
      child.kill();
    } catch {
      // ignore
    }
    void flux.close();
    throw error;
  }
  clearTimeout(readyTimeout);

  micSession = session;
  session.maxTimer = setTimeout(() => {
    const current = micSession;
    if (!current || current.mode !== "flux-stream" || current.id !== id) return;
    if (current.committed || current.stopping) return;
    console.warn(`[voice-cursor] flux-stt maxSeconds=${maxSeconds} id=${id}`);
    if (current.lastText.trim().length >= 2) {
      commitTurn(current.lastText);
    } else {
      try {
        child.stdin?.write("stop\n");
      } catch {
        // ignore
      }
      void current.flux.close();
    }
  }, maxSeconds * 1000);
  session.maxTimer.unref?.();

  console.log(
    `[voice-cursor] mic listening id=${id} mode=flux-stream eot=${resolveEotThreshold()} timeoutMs=${resolveEotTimeoutMs()}`,
  );
  return { id, startedAt, autoEnd: true, mode: "flux-stream" };
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

async function transcribeWavDeepgram(wavPath: string): Promise<string> {
  const key = deepgramKey();
  if (!key) throw new Error("DEEPGRAM_API_KEY not set");

  const model = process.env.VOICE_CURSOR_DEEPGRAM_STT_MODEL || DEFAULT_DEEPGRAM_STT_MODEL;
  const bytes = fs.readFileSync(wavPath);
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
  });

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "audio/wav",
    },
    body: bytes,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Deepgram STT HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const parsed = JSON.parse(raw) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
  };
  const text =
    parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  return text;
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
  const preferred = (process.env.VOICE_CURSOR_STT ?? "auto").toLowerCase();

  const tryDeepgram =
    cfg.resolved === "deepgram" || (preferred === "auto" && cfg.hasDeepgram);
  const tryOpenAI =
    cfg.resolved === "whisper-openai" ||
    (preferred === "auto" && cfg.hasOpenAI && !tryDeepgram) ||
    preferred.includes("openai");

  if (tryDeepgram && deepgramKey()) {
    try {
      const text = await transcribeWavDeepgram(wavPath);
      console.log(
        `[voice-cursor] transcribeWav deepgram done ms=${Date.now() - started} text=${text || "(empty)"}`,
      );
      return { text, engine: "deepgram" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[voice-cursor] Deepgram STT failed: ${message}`);
      if (preferred === "deepgram") {
        throw new Error(`Deepgram STT failed: ${message}`);
      }
      console.warn("[voice-cursor] falling back from Deepgram STT");
    }
  }

  if ((tryOpenAI || (preferred === "auto" && cfg.hasOpenAI)) && openaiKey()) {
    try {
      const text = await transcribeWavOpenAI(wavPath);
      console.log(
        `[voice-cursor] transcribeWav openai done ms=${Date.now() - started} text=${text || "(empty)"}`,
      );
      return { text, engine: "whisper-openai" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[voice-cursor] OpenAI Whisper failed: ${message}`);
      if (preferred.includes("openai")) {
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
  if (micSession.mode === "flux-stream") {
    return stopFluxMicSession(micSession);
  }
  return stopWavMicSession(micSession);
}

async function waitChildExit(child: ChildProc, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function stopFluxMicSession(session: StreamMicSession): Promise<{
  text: string;
  engine: string;
  id: string;
  durationMs: number;
}> {
  const started = Date.parse(session.startedAt);
  session.stopping = true;
  if (session.maxTimer) {
    clearTimeout(session.maxTimer);
    session.maxTimer = undefined;
  }
  console.log(
    `[voice-cursor] flux-stt stop id=${session.id} committed=${Boolean(session.committed)} lastChars=${session.lastText.length}`,
  );
  try {
    session.child.stdin?.write("stop\n");
  } catch {
    // ignore
  }

  if (!session.committed) {
    const waitMs = 1500;
    const deadline = Date.now() + waitMs;
    void session.flux.close();
    while (!session.committed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!session.committed && session.lastText.trim().length >= 2) {
      session.committed = {
        text: session.lastText.trim(),
        engine: "deepgram-flux",
      };
    }
  } else {
    void session.flux.close();
  }

  await waitChildExit(session.child, 4000);
  if (session.child.exitCode === null) {
    try {
      session.child.kill();
    } catch {
      // ignore
    }
  }

  if (micSession?.id === session.id) micSession = null;

  const text = session.committed?.text ?? "";
  const engine = session.committed?.engine ?? "deepgram-flux";
  console.log(
    `[voice-cursor] flux-stt stop done id=${session.id} chars=${text.length} engine=${engine}`,
  );
  return {
    text,
    engine,
    id: session.id,
    durationMs: Date.now() - started,
  };
}

async function stopWavMicSession(session: WavMicSession): Promise<{
  text: string;
  engine: string;
  id: string;
  durationMs: number;
}> {
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

  await waitChildExit(session.child, 12_000);

  if (session.child.exitCode === null) {
    try {
      session.child.kill();
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (micSession?.id === session.id) micSession = null;

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
  micSession = null;
  if (session.mode === "flux-stream") {
    session.stopping = true;
    if (session.maxTimer) {
      clearTimeout(session.maxTimer);
      session.maxTimer = undefined;
    }
    try {
      session.child.stdin?.write("stop\n");
    } catch {
      // ignore
    }
    try {
      session.child.kill();
    } catch {
      // ignore
    }
    void session.flux.close();
    return;
  }
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
  try {
    fs.rmSync(path.dirname(session.wavPath), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function playAudioFile(filePath: string): Promise<void> {
  const stat = fs.statSync(filePath);
  const minBytes = filePath.toLowerCase().endsWith(".wav") ? 200 : 500;
  if (stat.size < minBytes) {
    throw new Error(`Generated audio too small (${stat.size} bytes): ${filePath}`);
  }

  if (process.platform === "win32") {
    const playStarted = Date.now();
    try {
      const detail = await playViaWarmHost(filePath);
      console.log(
        `[voice-cursor] playback ${detail} wallMs=${Date.now() - playStarted}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // One-shot script fallback if the warm host dies.
      console.warn(`[voice-cursor] warm play host failed, fallback script: ${message}`);
      const script = resolveRepoScript("play-audio-windows.ps1");
      if (!script) throw new Error(`Audio playback failed: ${message}`);
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
        throw new Error(`Audio playback failed: ${detail || message}`);
      }
      console.log(
        `[voice-cursor] playback ${detail} wallMs=${Date.now() - playStarted}`,
      );
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

type PlayHost = {
  child: ReturnType<typeof import("node:child_process").spawn>;
  ready: Promise<void>;
  queue: Array<{
    settle: (value: string) => void;
    fail: (error: Error) => void;
  }>;
  buffer: string;
};

let playHost: PlayHost | null = null;

async function ensurePlayHost(): Promise<PlayHost> {
  if (playHost && playHost.child.exitCode === null) return playHost;

  const script = resolveRepoScript("play-audio-host.ps1");
  if (!script) throw new Error("scripts/play-audio-host.ps1 not found");

  const { spawn } = await import("node:child_process");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const host: PlayHost = {
    child,
    ready: Promise.resolve(),
    queue: [],
    buffer: "",
  };

  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  host.ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "ready") {
      readyResolve();
      return;
    }
    const pending = host.queue.shift();
    if (!pending) return;
    if (/^ok\b/i.test(trimmed)) pending.settle(trimmed);
    else pending.fail(new Error(trimmed));
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    host.buffer += String(chunk);
    let idx: number;
    while ((idx = host.buffer.indexOf("\n")) >= 0) {
      const line = host.buffer.slice(0, idx);
      host.buffer = host.buffer.slice(idx + 1);
      onLine(line.replace(/\r$/, ""));
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    console.warn(`[voice-cursor] play-host stderr: ${String(chunk).trim()}`);
  });
  child.on("exit", (code) => {
    console.warn(`[voice-cursor] play-host exited code=${code}`);
    const err = new Error(`play-host exited (${code})`);
    for (const pending of host.queue.splice(0)) pending.fail(err);
    if (playHost === host) playHost = null;
    readyReject(err);
  });

  // Ready timeout
  const timeout = setTimeout(() => {
    readyReject(new Error("play-host ready timeout"));
  }, 8_000);
  host.ready = host.ready.finally(() => clearTimeout(timeout));

  playHost = host;
  await host.ready;
  console.log("[voice-cursor] play-host ready");
  return host;
}

async function playViaWarmHost(filePath: string): Promise<string> {
  const host = await ensurePlayHost();
  return await new Promise<string>((resolve, reject) => {
    host.queue.push({ settle: resolve, fail: reject });
    try {
      host.child.stdin?.write(`${filePath}\n`);
    } catch (error) {
      host.queue.pop();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

type PcmPlaySession = {
  write: (pcm: Buffer) => void;
  end: () => Promise<{ detail: string; firstMs?: number }>;
};

type PcmHost = {
  child: ReturnType<typeof import("node:child_process").spawn>;
  ready: Promise<void>;
  buffer: string;
  session: {
    firstMs?: number;
    ending: null | {
      settle: (value: { detail: string; firstMs?: number }) => void;
      fail: (error: Error) => void;
    };
  } | null;
};

let pcmHost: PcmHost | null = null;

async function ensurePcmHost(): Promise<PcmHost> {
  if (pcmHost && pcmHost.child.exitCode === null) return pcmHost;

  const script = resolveRepoScript("play-pcm-host.ps1");
  if (!script) throw new Error("scripts/play-pcm-host.ps1 not found");

  const { spawn } = await import("node:child_process");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const host: PcmHost = {
    child,
    ready: Promise.resolve(),
    buffer: "",
    session: null,
  };

  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  host.ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "ready") {
      readyResolve();
      return;
    }
    const session = host.session;
    if (!session) return;
    if (/^first\b/i.test(trimmed)) {
      const m = /(?:firstMs|ms)=(\d+)/i.exec(trimmed);
      const n = m ? Number(m[1]) : undefined;
      if (Number.isFinite(n)) session.firstMs = n;
      return;
    }
    if (/^ok\b/i.test(trimmed)) {
      const ending = session.ending;
      const firstMs = session.firstMs;
      host.session = null;
      if (!ending) return;
      const m = /firstMs=(-?\d+)/i.exec(trimmed);
      const n = m ? Number(m[1]) : undefined;
      ending.settle({
        detail: trimmed,
        firstMs:
          firstMs ??
          (Number.isFinite(n) && (n as number) >= 0 ? (n as number) : undefined),
      });
      return;
    }
    if (/^err\b/i.test(trimmed)) {
      const ending = session.ending;
      host.session = null;
      if (ending) ending.fail(new Error(trimmed));
      return;
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    host.buffer += String(chunk);
    let idx: number;
    while ((idx = host.buffer.indexOf("\n")) >= 0) {
      const line = host.buffer.slice(0, idx);
      host.buffer = host.buffer.slice(idx + 1);
      onLine(line.replace(/\r$/, ""));
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    console.warn(`[voice-cursor] pcm-host stderr: ${String(chunk).trim()}`);
  });
  child.on("exit", (code) => {
    console.warn(`[voice-cursor] pcm-host exited code=${code}`);
    const err = new Error(`pcm-host exited (${code})`);
    if (host.session?.ending) host.session.ending.fail(err);
    host.session = null;
    if (pcmHost === host) pcmHost = null;
    readyReject(err);
  });

  const timeout = setTimeout(() => {
    readyReject(new Error("pcm-host ready timeout"));
  }, 12_000);
  host.ready = host.ready.finally(() => clearTimeout(timeout));

  pcmHost = host;
  await host.ready;
  console.log("[voice-cursor] pcm-host ready");
  return host;
}

/**
 * Gapless linear16 playback via warm waveOut host (Windows).
 * Call write() with PCM frames, then end() when the stream is finished.
 */
async function startPcmPlaySession(options: {
  sampleRate: number;
  channels?: number;
  bitsPerSample?: number;
}): Promise<PcmPlaySession> {
  if (process.platform !== "win32") {
    throw new Error("PCM stream playback is Windows-only for now");
  }
  const host = await ensurePcmHost();
  if (host.session) {
    throw new Error("PCM play session already active");
  }

  const channels = options.channels ?? 1;
  const bits = options.bitsPerSample ?? 16;
  host.session = { ending: null };
  host.child.stdin?.write(
    `start ${options.sampleRate} ${channels} ${bits}\n`,
  );

  let ended = false;
  return {
    write(pcm: Buffer) {
      if (ended || !pcm.length) return;
      const b64 = pcm.toString("base64");
      const max = 24_000;
      for (let i = 0; i < b64.length; i += max) {
        host.child.stdin?.write(`pcm ${b64.slice(i, i + max)}\n`);
      }
    },
    end() {
      if (ended) {
        return Promise.resolve({
          detail: "ok already-ended",
          firstMs: host.session?.firstMs,
        });
      }
      ended = true;
      return new Promise<{ detail: string; firstMs?: number }>((resolve, reject) => {
        if (!host.session) {
          reject(new Error("PCM session missing"));
          return;
        }
        host.session.ending = { settle: resolve, fail: reject };
        try {
          host.child.stdin?.write("end\n");
        } catch (error) {
          host.session = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
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
  const cfg = describeTtsConfig();
  if (cfg.resolved === "windows") return;
  try {
    if (process.platform === "win32") {
      await ensurePlayHost();
      if (cfg.stream) {
        try {
          await ensurePcmHost();
        } catch (error) {
          console.warn(
            "[voice-cursor] pcm-host warm failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    if (cfg.resolved === "deepgram" && deepgramKey()) {
      const model = resolveDeepgramTtsModel();
      if (shouldStreamDeepgramTts(model)) {
        // Warm TLS + Flux WS handshake (kept alive with pings).
        await ensureFluxSession();
      } else {
        // Tiny synth to warm TLS + auth to Deepgram Speak REST.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-warm-"));
        try {
          await synthDeepgramChunk("Hi.", path.join(tmpDir, "warm.mp3"));
        } finally {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      }
    } else {
      const voice = process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE;
      const tts = await getEdgeClient(voice);
      const prosody = new ProsodyOptions();
      prosody.rate = resolveTtsRate();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-warm-"));
      try {
        const { audioFilePath } = await tts.toFile(tmpDir, ".", prosody);
        try {
          fs.unlinkSync(audioFilePath);
        } catch {
          // ignore
        }
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
    console.log(
      `[voice-cursor] TTS warm-up complete resolved=${cfg.resolved} stream=${cfg.stream}`,
    );
  } catch (error) {
    console.warn(
      "[voice-cursor] TTS warm-up failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

let fluxSession: FluxTtsSession | null = null;

async function ensureFluxSession(): Promise<FluxTtsSession> {
  const key = deepgramKey();
  if (!key) throw new Error("DEEPGRAM_API_KEY not set");
  const model = resolveDeepgramTtsModel();
  const speed = resolveDeepgramTtsSpeed();
  const configKey = `${model}|${speed}`;
  if (fluxSession && fluxSession.configKey === configKey) {
    await fluxSession.ensureConnected();
    return fluxSession;
  }
  if (fluxSession) {
    try {
      await fluxSession.close();
    } catch {
      // ignore
    }
    fluxSession = null;
  }
  const session = new FluxTtsSession({ apiKey: key, model, speed });
  await session.ensureConnected();
  fluxSession = session;
  return session;
}

async function synthDeepgramChunk(text: string, outPath: string): Promise<string> {
  const key = deepgramKey();
  if (!key) throw new Error("DEEPGRAM_API_KEY not set");

  const model = resolveDeepgramTtsModel();
  const speed = resolveDeepgramTtsSpeed();
  const flux = isFluxTtsModel(model);
  const params = new URLSearchParams({
    model,
    encoding: "mp3",
    speed: String(speed),
  });
  // Flux voices live on /v2/speak; Aura remains on /v1/speak.
  const endpoint = flux
    ? `https://api.deepgram.com/v2/speak?${params}`
    : `https://api.deepgram.com/v1/speak?${params}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Deepgram TTS HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) {
    throw new Error(`Deepgram TTS audio too small (${buf.length} bytes)`);
  }
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/** Fallback: sentence WAVs via MCI when waveOut PCM host isn't available. */
function sentencesForFluxTts(text: string, maxChars = 500): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const sentences =
    cleaned.match(/[^.!?…]+(?:[.!?…]["']?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [
      cleaned,
    ];

  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      out.push(sentence);
      continue;
    }
    let remaining = sentence;
    while (remaining.length > maxChars) {
      let cut = remaining.lastIndexOf(" ", maxChars);
      if (cut < maxChars * 0.4) cut = maxChars;
      out.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) out.push(remaining);
  }
  return out;
}

/**
 * Flux WebSocket + gapless waveOut: stream PCM as it arrives (low TTFA, no MCI chops).
 * Falls back to sentence WAV files if the PCM host isn't usable.
 */
async function speakWithDeepgramFluxStream(text: string): Promise<{
  engine: string;
  voice: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  if (process.platform === "win32") {
    try {
      return await speakWithDeepgramFluxPcmStream(text);
    } catch (error) {
      console.warn(
        "[voice-cursor] PCM stream playback failed, falling back to sentence WAVs:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return speakWithDeepgramFluxSentenceWavs(text);
}

/** Preferred path: Flux turns per structure chunk, with real silence between paragraphs/lists. */
async function speakWithDeepgramFluxPcmStream(text: string): Promise<{
  engine: string;
  voice: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  const voice = resolveDeepgramTtsModel();
  const speed = resolveDeepgramTtsSpeed();
  const totalStarted = Date.now();

  console.log(
    `[voice-cursor] deepgram-tts-ws pcm-stream chars=${text.length} voice=${voice} speed=${speed} sampleRate=${FLUX_TTS_SAMPLE_RATE}`,
  );

  const session = await ensureFluxSession();
  const player = await startPcmPlaySession({ sampleRate: FLUX_TTS_SAMPLE_RATE });
  let audioBytes = 0;

  try {
    const turn = await session.speakTurn(text, (pcm) => {
      audioBytes += pcm.length;
      player.write(pcm);
    });
    const play = await player.end();

    if (!audioBytes && !turn.audioBytes) {
      throw new Error("Flux TTS produced no audio");
    }

    // play.firstMs is measured from waveOut session start (≈ this function's start).
    const firstAudioMs =
      play.firstMs !== undefined && play.firstMs >= 0
        ? play.firstMs
        : turn.firstByteMs;

    const totalMs = Date.now() - totalStarted;
    console.log(
      `[voice-cursor] deepgram-tts-ws pcm-stream totalMs=${totalMs} firstAudioMs=${firstAudioMs ?? "n/a"} firstByteMs=${turn.firstByteMs ?? "n/a"} play=${play.detail} audioBytes=${turn.audioBytes}`,
    );
    return {
      engine: "deepgram-tts-ws",
      voice,
      firstAudioMs,
      totalMs,
    };
  } catch (error) {
    try {
      await player.end();
    } catch {
      // ignore
    }
    throw error;
  }
}

/** Fallback path: one sentence per Flux turn, play each as a single WAV via MCI. */
async function speakWithDeepgramFluxSentenceWavs(text: string): Promise<{
  engine: string;
  voice: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  const voice = resolveDeepgramTtsModel();
  const speed = resolveDeepgramTtsSpeed();
  const totalStarted = Date.now();
  let firstAudioMs: number | undefined;
  const sentences = sentencesForFluxTts(text);

  console.log(
    `[voice-cursor] deepgram-tts-ws sentence-wavs sentences=${sentences.length} chars=${text.length} voice=${voice} speed=${speed}`,
  );

  const session = await ensureFluxSession();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-dg-ws-"));

  const synthSentence = async (
    sentence: string,
    index: number,
  ): Promise<{ wavPath: string; pcmBytes: number }> => {
    const synthStarted = Date.now();
    const parts: Buffer[] = [];
    const turn = await session.speakTurn(sentence, (pcm) => {
      parts.push(pcm);
    });
    const pcmBuf = Buffer.concat(parts);
    if (pcmBuf.length < 2) {
      throw new Error(`Flux TTS sentence ${index} produced no audio`);
    }
    const wavPath = path.join(tmpDir, `sentence-${index}.wav`);
    writePcmWavFile(wavPath, pcmBuf);
    console.log(
      `[voice-cursor] deepgram-tts-ws sentence=${index} chars=${sentence.length} pcmBytes=${pcmBuf.length} firstByteMs=${turn.firstByteMs ?? "n/a"} synthMs=${Date.now() - synthStarted}`,
    );
    return { wavPath, pcmBytes: pcmBuf.length };
  };

  try {
    let nextFile =
      sentences.length > 0 ? synthSentence(sentences[0], 0) : null;
    let played = 0;

    for (let i = 0; i < sentences.length; i++) {
      const audio = await nextFile!;
      nextFile =
        i + 1 < sentences.length
          ? synthSentence(sentences[i + 1], i + 1)
          : null;

      if (firstAudioMs === undefined) {
        firstAudioMs = Date.now() - totalStarted;
        console.log(
          `[voice-cursor] deepgram-tts-ws firstAudioMs=${firstAudioMs} sentence=${i} bytes=${audio.pcmBytes}`,
        );
      }
      await playAudioFile(audio.wavPath);
      played += 1;
      try {
        fs.unlinkSync(audio.wavPath);
      } catch {
        // ignore
      }
    }

    if (played === 0) throw new Error("Flux TTS produced no audio");

    const totalMs = Date.now() - totalStarted;
    console.log(
      `[voice-cursor] deepgram-tts-ws sentence-wavs totalMs=${totalMs} firstAudioMs=${firstAudioMs ?? "n/a"} sentences=${played}`,
    );
    return { engine: "deepgram-tts-ws", voice, firstAudioMs, totalMs };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function speakWithDeepgramRest(text: string): Promise<{
  engine: string;
  voice: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  const voice = resolveDeepgramTtsModel();
  const speed = resolveDeepgramTtsSpeed();
  const totalStarted = Date.now();
  let firstAudioMs: number | undefined;
  const chunks = chunkForTts(text);
  console.log(
    `[voice-cursor] deepgram-tts-rest speak chunks=${chunks.length} chars=${text.length} voice=${voice} speed=${speed}`,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-dg-tts-"));
  try {
    const synthChunk = async (chunk: string, index: number): Promise<string> => {
      const synthStarted = Date.now();
      const outPath = path.join(tmpDir, `chunk-${index}.mp3`);
      await synthDeepgramChunk(chunk, outPath);
      const bytes = fs.statSync(outPath).size;
      console.log(
        `[voice-cursor] deepgram-tts-rest chunk=${index} bytes=${bytes} voice=${voice} speed=${speed} synthMs=${Date.now() - synthStarted}`,
      );
      return outPath;
    };

    let nextFile = chunks.length > 0 ? synthChunk(chunks[0], 0) : null;
    for (let i = 0; i < chunks.length; i++) {
      const audioFilePath = await nextFile!;
      nextFile =
        i + 1 < chunks.length ? synthChunk(chunks[i + 1], i + 1) : null;
      if (firstAudioMs === undefined) {
        firstAudioMs = Date.now() - totalStarted;
        console.log(`[voice-cursor] deepgram-tts-rest firstAudioMs=${firstAudioMs}`);
      }
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

  const totalMs = Date.now() - totalStarted;
  console.log(
    `[voice-cursor] deepgram-tts-rest totalMs=${totalMs} firstAudioMs=${firstAudioMs ?? "n/a"}`,
  );
  return { engine: "deepgram-tts", voice, firstAudioMs, totalMs };
}

async function speakWithDeepgram(text: string): Promise<{
  engine: string;
  voice: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  const model = resolveDeepgramTtsModel();
  if (shouldStreamDeepgramTts(model)) {
    try {
      return await speakWithDeepgramFluxStream(text);
    } catch (error) {
      console.warn(
        "[voice-cursor] Flux WebSocket TTS failed, falling back to REST:",
        error instanceof Error ? error.message : error,
      );
      // Drop broken session so the next attempt reconnects.
      if (fluxSession) {
        try {
          await fluxSession.close();
        } catch {
          // ignore
        }
        fluxSession = null;
      }
      return await speakWithDeepgramRest(text);
    }
  }
  return speakWithDeepgramRest(text);
}

async function speakWithEdge(text: string): Promise<{
  engine: string;
  voice: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  const voice = process.env.VOICE_CURSOR_TTS_VOICE ?? DEFAULT_EDGE_VOICE;
  const rate = resolveTtsRate();
  const totalStarted = Date.now();
  let firstAudioMs: number | undefined;
  const tts = await getEdgeClient(voice);
  const prosody = new ProsodyOptions();
  prosody.rate = rate;

  const chunks = chunkForTts(text);
  console.log(
    `[voice-cursor] edge-tts speak chunks=${chunks.length} chars=${text.length} rate=${rate}`,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cursor-tts-"));
  try {
    const synthChunk = async (chunk: string, index: number): Promise<string> => {
      const synthStarted = Date.now();
      const { audioFilePath } = await tts.toFile(tmpDir, escapeXml(chunk), prosody);
      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Edge TTS did not write audio file for voice=${voice}`);
      }
      const bytes = fs.statSync(audioFilePath).size;
      console.log(
        `[voice-cursor] edge-tts chunk=${index} bytes=${bytes} voice=${voice} rate=${rate} synthMs=${Date.now() - synthStarted}`,
      );
      return audioFilePath;
    };

    // Pipeline: synthesize N+1 while playing N so first audio starts ASAP
    // and gaps between sentences stay small.
    let nextFile = chunks.length > 0 ? synthChunk(chunks[0], 0) : null;
    for (let i = 0; i < chunks.length; i++) {
      const audioFilePath = await nextFile!;
      nextFile =
        i + 1 < chunks.length ? synthChunk(chunks[i + 1], i + 1) : null;
      if (firstAudioMs === undefined) {
        firstAudioMs = Date.now() - totalStarted;
        console.log(`[voice-cursor] edge-tts firstAudioMs=${firstAudioMs}`);
      }
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

  const totalMs = Date.now() - totalStarted;
  console.log(
    `[voice-cursor] edge-tts totalMs=${totalMs} firstAudioMs=${firstAudioMs ?? "n/a"}`,
  );
  return { engine: "edge-tts", voice, firstAudioMs, totalMs };
}

async function speakWithWindowsSapi(text: string): Promise<{
  engine: string;
  firstAudioMs?: number;
  totalMs: number;
}> {
  const script = resolveRepoScript("tts-windows.ps1");
  if (!script) {
    throw new Error("scripts/tts-windows.ps1 not found");
  }
  const started = Date.now();
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Text", text],
    {
      windowsHide: true,
      timeout: Math.max(30_000, text.length * 80),
      maxBuffer: 1024 * 1024,
    },
  );
  const totalMs = Date.now() - started;
  return { engine: "windows-sapi", firstAudioMs: 0, totalMs };
}

export async function speakText(text: string): Promise<{
  engine: string;
  voice?: string;
  firstAudioMs?: number;
  totalMs?: number;
}> {
  const cleaned = text.trim();
  if (!cleaned) return { engine: "none", totalMs: 0 };

  const cfg = describeTtsConfig();
  const preferred = cfg.engine;

  if (preferred === "windows" || cfg.resolved === "windows") {
    if (process.platform !== "win32") {
      throw new Error("VOICE_CURSOR_TTS=windows is only supported on Windows");
    }
    return speakWithWindowsSapi(cleaned);
  }

  if (cfg.resolved === "deepgram" || preferred === "deepgram") {
    if (!deepgramKey()) {
      throw new Error("DEEPGRAM_API_KEY not set for Deepgram TTS");
    }
    try {
      return await speakWithDeepgram(cleaned);
    } catch (error) {
      console.warn(
        "[voice-cursor] Deepgram TTS failed, falling back to Edge:",
        error instanceof Error ? error.message : error,
      );
      if (preferred === "deepgram") throw error;
    }
  }

  try {
    return await speakWithEdge(cleaned);
  } catch (error) {
    console.warn(
      "[voice-cursor] Edge TTS failed, falling back to Windows SAPI:",
      error instanceof Error ? error.message : error,
    );
    if (process.platform === "win32") {
      return speakWithWindowsSapi(cleaned);
    }
    throw error;
  }
}
