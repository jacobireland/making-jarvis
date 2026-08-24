import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
