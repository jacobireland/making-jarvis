import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export type InjectionStrategy =
  | "auto"
  | "composer.newAgentChat+paste+submit"
  | "composer.newAgentChat+paste"
  | "clipboard-only";

export type SubmitChord = "enter" | "ctrl-enter" | "both";

export type InjectResult = {
  usedStrategy: string;
  submitted: boolean;
  submitMethod?: string;
  triedSubmitCommands: string[];
  openedWith?: string;
  details: string[];
  timingMs?: Record<string, number>;
};

/**
 * Inject a prompt into Cursor Agent and attempt auto-submit.
 *
 * Cursor does not expose a reliable submit command. Working approach used by
 * community tools: focus composer, paste, then OS-level Enter into the Cursor
 * window (not a child PowerShell that steals focus).
 */
export async function injectPrompt(
  prompt: string,
  options: {
    strategy: InjectionStrategy;
    submitCandidates: string[];
    log: (message: string) => void;
    newChat?: boolean;
    extensionPath?: string;
    /** Which key to send after paste. Default enter (fastest). */
    submitChord?: SubmitChord;
  },
): Promise<InjectResult> {
  const { strategy, log } = options;
  const newChat = options.newChat ?? false;
  const submitChord: SubmitChord = options.submitChord ?? "enter";
  const details: string[] = [];
  const t0 = Date.now();
  const mark = (label: string) => {
    const ms = Date.now() - t0;
    log(`t+${ms}ms ${label}`);
    return ms;
  };
  const timingMs: Record<string, number> = {};
  const previousClipboard = await vscode.env.clipboard.readText();

  try {
    await vscode.env.clipboard.writeText(prompt);
    timingMs.clipboard = mark("clipboard written");

    if (strategy === "clipboard-only") {
      return {
        usedStrategy: "clipboard-only",
        submitted: false,
        triedSubmitCommands: [],
        details,
        timingMs,
      };
    }

    let openedWith: string | undefined;
    if (newChat) {
      const openCandidates = [
        "composer.newAgentChat",
        "composer.createNewComposerTab",
        "aichat.newchat",
      ];
      openedWith = await tryFirstAvailableCommand(openCandidates, log);
      if (!openedWith && strategy !== "auto") {
        throw new Error(`No chat-open command available from: ${openCandidates.join(", ")}`);
      }
      if (!openedWith) {
        log("no open-chat command succeeded; prompt remains on clipboard");
        return {
          usedStrategy: "clipboard-only-fallback",
          submitted: false,
          triedSubmitCommands: [],
          details,
          timingMs,
        };
      }
      await delay(120);
    } else {
      openedWith = "current-chat";
    }
    timingMs.chatReady = mark(`chat ready (${openedWith})`);

    await tryCommand("composer.focusComposer", log);
    await delay(60);

    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    timingMs.pasted = mark(`pasted after ${openedWith}`);
    await delay(100);

    const shouldSubmit =
      strategy === "auto" || strategy === "composer.newAgentChat+paste+submit";
    const triedSubmitCommands: string[] = [];
    let submitted = false;
    let submitMethod: string | undefined;

    if (shouldSubmit) {
      // Do NOT use vscode `type \n` — in Composer that inserts a newline, not submit.
      // Do NOT run speculative composer.* "submit" commands before Enter — they can
      // close/reopen panels (e.g. startComposerPrompt).

      await tryCommand("composer.focusComposer", log);
      await delay(60);

      const chords: Array<"enter" | "ctrl-enter"> =
        submitChord === "both"
          ? ["enter", "ctrl-enter"]
          : submitChord === "ctrl-enter"
            ? ["ctrl-enter"]
            : ["enter"];

      for (const chord of chords) {
        const result = await sendEnterToCursor(chord, options.extensionPath, log);
        details.push(`os-${chord}: ${result.detail}`);
        if (result.ok) {
          submitted = true;
          if (!submitMethod) submitMethod = `os-${chord}`;
          log(`sent focus-safe OS ${chord}`);
        }
      }
      timingMs.submitted = mark(`submit done method=${submitMethod ?? "none"}`);

      // Record whether known submit command IDs even exist (informational only).
      const available = await vscode.commands.getCommands(true);
      const availableSet = new Set(available);
      for (const commandId of [
        "composer.startGeneration",
        ...options.submitCandidates,
        "workbench.action.chat.submit",
      ]) {
        triedSubmitCommands.push(commandId);
        if (availableSet.has(commandId)) {
          log(`submit candidate exists (not executed): ${commandId}`);
        } else {
          log(`submit candidate missing: ${commandId}`);
        }
      }
    }

    timingMs.total = mark("inject complete");
    return {
      usedStrategy: `${openedWith}+paste${submitted ? `+${submitMethod}` : ""}`,
      submitted,
      submitMethod,
      triedSubmitCommands,
      openedWith,
      details,
      timingMs,
    };
  } finally {
    // Restore clipboard off the critical path as much as possible.
    await delay(100);
    try {
      await vscode.env.clipboard.writeText(previousClipboard);
    } catch {
      // ignore
    }
  }
}

export async function sendEnterToCursor(
  chord: "enter" | "ctrl-enter",
  extensionPath: string | undefined,
  log: (message: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "win32") {
    return sendEnterKeyNonWindows(chord, log);
  }

  try {
    const detail = await sendEnterViaWarmHost(chord, extensionPath);
    log(`send-enter-host: ${detail}`);
    return { ok: /ok focused=/i.test(detail), detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`send-enter-host failed, falling back to one-shot: ${message}`);
    return sendEnterOneShot(chord, extensionPath, log);
  }
}

async function sendEnterOneShot(
  chord: "enter" | "ctrl-enter",
  extensionPath: string | undefined,
  log: (message: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  const script = resolveScript(extensionPath, "send-enter.ps1");
  if (!script) {
    log("send-enter.ps1 not found");
    return { ok: false, detail: "script missing" };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Chord",
        chord,
      ],
      { windowsHide: true, timeout: 8000 },
    );
    const detail = `${stdout} ${stderr}`.trim();
    log(`send-enter.ps1: ${detail}`);
    return { ok: /ok focused=/i.test(detail), detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`send-enter.ps1 failed: ${message}`);
    return { ok: false, detail: message };
  }
}

type EnterHost = {
  child: ReturnType<typeof import("node:child_process").spawn>;
  ready: Promise<void>;
  queue: Array<{
    settle: (value: string) => void;
    fail: (error: Error) => void;
  }>;
  buffer: string;
};

let enterHost: EnterHost | null = null;
let enterHostExtensionPath: string | undefined;

function resolveScript(extensionPath: string | undefined, name: string): string | undefined {
  const candidates = [
    extensionPath ? path.join(extensionPath, "..", "scripts", name) : "",
    path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", "scripts", name),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Warm the persistent Enter host so first submit isn't paying PowerShell cold start. */
export async function warmSendEnterHost(extensionPath?: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await ensureEnterHost(extensionPath);
  } catch {
    // ignore — one-shot fallback still works
  }
}

async function ensureEnterHost(extensionPath?: string): Promise<EnterHost> {
  if (
    enterHost &&
    enterHost.child.exitCode === null &&
    enterHostExtensionPath === extensionPath
  ) {
    return enterHost;
  }

  const script = resolveScript(extensionPath, "send-enter-host.ps1");
  if (!script) throw new Error("scripts/send-enter-host.ps1 not found");

  const { spawn } = await import("node:child_process");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const host: EnterHost = {
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
    // keep quiet unless debugging — stderr can be noisy
    void chunk;
  });
  child.on("exit", (code) => {
    const err = new Error(`send-enter-host exited (${code})`);
    for (const pending of host.queue.splice(0)) pending.fail(err);
    if (enterHost === host) enterHost = null;
    readyReject(err);
  });

  const timeout = setTimeout(() => {
    readyReject(new Error("send-enter-host ready timeout"));
  }, 8_000);
  host.ready = host.ready.finally(() => clearTimeout(timeout));

  enterHost = host;
  enterHostExtensionPath = extensionPath;
  await host.ready;
  return host;
}

async function sendEnterViaWarmHost(
  chord: "enter" | "ctrl-enter",
  extensionPath?: string,
): Promise<string> {
  const host = await ensureEnterHost(extensionPath);
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("send-enter-host timed out"));
    }, 5_000);
    host.queue.push({
      settle: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      fail: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      host.child.stdin?.write(`${chord}\n`);
    } catch (error) {
      host.queue.pop();
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function resolveSendEnterScript(extensionPath?: string): string | undefined {
  return resolveScript(extensionPath, "send-enter.ps1");
}

async function sendEnterKeyNonWindows(
  chord: "enter" | "ctrl-enter",
  log: (message: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  try {
    if (process.platform === "darwin") {
      const src =
        chord === "ctrl-enter"
          ? 'tell application "System Events" to keystroke return using control down'
          : 'tell application "System Events" to keystroke return';
      await execFileAsync("osascript", ["-e", src], { timeout: 5000 });
      return { ok: true, detail: "osascript" };
    }
    const args = chord === "ctrl-enter" ? ["key", "ctrl+Return"] : ["key", "Return"];
    await execFileAsync("xdotool", args, { timeout: 5000 });
    return { ok: true, detail: "xdotool" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`non-windows enter failed: ${message}`);
    return { ok: false, detail: message };
  }
}

async function tryFirstAvailableCommand(
  commandIds: string[],
  log: (message: string) => void,
): Promise<string | undefined> {
  const available = await vscode.commands.getCommands(true);
  const set = new Set(available);
  for (const id of commandIds) {
    if (!set.has(id)) {
      log(`command missing: ${id}`);
      continue;
    }
    if (await tryCommand(id, log)) return id;
  }
  return undefined;
}

async function tryCommand(commandId: string, log: (message: string) => void): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(commandId);
    log(`ran command: ${commandId}`);
    return true;
  } catch (error) {
    log(`command failed: ${commandId} (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
