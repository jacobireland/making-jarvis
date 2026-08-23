import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SttEngine = "auto" | "whisper-openai" | "whisper-groq" | "windows";

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

function preferredSttEngine(): SttEngine {
  const raw = (process.env.VOICE_CURSOR_STT ?? "auto").toLowerCase();
  if (
    raw === "whisper-openai" ||
    raw === "whisper-groq" ||
    raw === "windows" ||
    raw === "auto"
  ) {
    return raw;
  }
  return "auto";
}

function openaiKey(): string | undefined {
  return (
    process.env.VOICE_CURSOR_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    undefined
  );
}

function groqKey(): string | undefined {
  return process.env.VOICE_CURSOR_GROQ_API_KEY || process.env.GROQ_API_KEY || undefined;
}

export function describeSttConfig(): {
  engine: SttEngine;
  resolved: string;
  hasOpenAI: boolean;
  hasGroq: boolean;
} {
  const engine = preferredSttEngine();
  const hasOpenAI = Boolean(openaiKey());
  const hasGroq = Boolean(groqKey());
  let resolved = "windows";
  if (engine === "whisper-openai" && hasOpenAI) resolved = "whisper-openai";
  else if (engine === "whisper-groq" && hasGroq) resolved = "whisper-groq";
  else if (engine === "auto" && hasOpenAI) resolved = "whisper-openai";
  else if (engine === "auto" && hasGroq) resolved = "whisper-groq";
  else if (engine === "windows") resolved = "windows";
  else if (engine.startsWith("whisper")) resolved = `${engine} (missing API key → windows fallback)`;
  return { engine, resolved, hasOpenAI, hasGroq };
}

async function recordMicWav(seconds: number): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Mic recording is currently implemented for Windows only");
  }
  const script = resolveRepoScript("record-mic-windows.ps1");
  if (!script) throw new Error("scripts/record-mic-windows.ps1 not found");

  const outFile = path.join(
    os.tmpdir(),
    `voice-cursor-${Date.now()}-${process.pid}.wav`,
  );

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
      "-OutFile",
      outFile,
    ],
    {
      windowsHide: true,
      timeout: (seconds + 20) * 1000,
      maxBuffer: 1024 * 1024,
    },
  );

  if (!fs.existsSync(outFile)) {
    throw new Error(
      `Mic recording failed. stdout=${stdout} stderr=${stderr}`.trim(),
    );
  }
  return outFile;
}

async function transcribeWhisper(options: {
  wavPath: string;
  provider: "openai" | "groq";
}): Promise<string> {
  const key = options.provider === "openai" ? openaiKey() : groqKey();
  if (!key) throw new Error(`Missing API key for ${options.provider}`);

  const url =
    options.provider === "openai"
      ? "https://api.openai.com/v1/audio/transcriptions"
      : "https://api.groq.com/openai/v1/audio/transcriptions";
  const model =
    options.provider === "openai"
      ? process.env.VOICE_CURSOR_WHISPER_MODEL || "whisper-1"
      : process.env.VOICE_CURSOR_GROQ_WHISPER_MODEL || "whisper-large-v3";

  const bytes = fs.readFileSync(options.wavPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`${options.provider} whisper HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const parsed = JSON.parse(raw) as { text?: string };
  return (parsed.text ?? "").trim();
}

async function listenWindowsSystemSpeech(seconds: number): Promise<string> {
  const script = resolveRepoScript("stt-windows.ps1");
  if (!script) throw new Error("scripts/stt-windows.ps1 not found");
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
  if (!text && stderr?.trim()) throw new Error(stderr.trim());
  return text;
}

export async function listenOnce(options: {
  seconds?: number;
}): Promise<{ text: string; engine: string }> {
  const seconds = options.seconds ?? 7;
  const engine = preferredSttEngine();
  const cfg = describeSttConfig();

  const tryWhisper = async (
    provider: "openai" | "groq",
  ): Promise<{ text: string; engine: string }> => {
    const wavPath = await recordMicWav(seconds);
    try {
      const text = await transcribeWhisper({ wavPath, provider });
      return {
        text,
        engine: provider === "openai" ? "whisper-openai" : "whisper-groq",
      };
    } finally {
      try {
        fs.unlinkSync(wavPath);
      } catch {
        // ignore
      }
    }
  };

  if (engine === "whisper-openai") {
    if (!openaiKey()) {
      throw new Error(
        "VOICE_CURSOR_STT=whisper-openai but no OPENAI_API_KEY / VOICE_CURSOR_OPENAI_API_KEY set",
      );
    }
    return tryWhisper("openai");
  }

  if (engine === "whisper-groq") {
    if (!groqKey()) {
      throw new Error(
        "VOICE_CURSOR_STT=whisper-groq but no GROQ_API_KEY / VOICE_CURSOR_GROQ_API_KEY set",
      );
    }
    return tryWhisper("groq");
  }

  if (engine === "auto") {
    if (openaiKey()) {
      try {
        return await tryWhisper("openai");
      } catch (error) {
        console.warn(
          "[voice-cursor] OpenAI whisper failed, falling back:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (groqKey()) {
      try {
        return await tryWhisper("groq");
      } catch (error) {
        console.warn(
          "[voice-cursor] Groq whisper failed, falling back:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  // windows or auto fallback
  if (process.platform !== "win32") {
    throw new Error(
      `No Whisper API key configured and Windows STT unavailable on ${process.platform}. Set OPENAI_API_KEY or GROQ_API_KEY.`,
    );
  }

  console.log(`[voice-cursor] STT using windows-system-speech (resolved=${cfg.resolved})`);
  const text = await listenWindowsSystemSpeech(seconds);
  return { text, engine: "windows-system-speech" };
}

export async function speakText(text: string): Promise<{ engine: string }> {
  const cleaned = text.trim();
  if (!cleaned) return { engine: "none" };

  if (process.platform === "win32") {
    const script = resolveRepoScript("tts-windows.ps1");
    if (!script) {
      throw new Error("scripts/tts-windows.ps1 not found");
    }
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Text",
        cleaned,
      ],
      {
        windowsHide: true,
        timeout: Math.max(30_000, cleaned.length * 80),
        maxBuffer: 1024 * 1024,
      },
    );
    return { engine: "windows-sapi" };
  }

  if (process.platform === "darwin") {
    await execFileAsync("say", [cleaned], { timeout: 60_000 });
    return { engine: "macos-say" };
  }

  try {
    await execFileAsync("espeak", [cleaned], { timeout: 60_000 });
    return { engine: "espeak" };
  } catch {
    throw new Error("No TTS engine available (install espeak or use Windows/macOS)");
  }
}
