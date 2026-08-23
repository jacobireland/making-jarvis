import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export type InjectionStrategy =
  | "auto"
  | "composer.newAgentChat+paste+submit"
  | "composer.newAgentChat+paste"
  | "clipboard-only";

export type InjectResult = {
  usedStrategy: string;
  submitted: boolean;
  submitMethod?: string;
  triedSubmitCommands: string[];
  openedWith?: string;
};

/**
 * Inject a prompt into Cursor Agent and attempt auto-submit.
 *
 * Important: many composer.* commands return without error but do NOT submit.
 * On Cursor, the reliable community approach is focusComposer + OS-level Enter.
 */
export async function injectPrompt(
  prompt: string,
  options: {
    strategy: InjectionStrategy;
    submitCandidates: string[];
    log: (message: string) => void;
    /** If true, open a new agent chat. If false, try to use current chat. */
    newChat?: boolean;
  },
): Promise<InjectResult> {
  const { strategy, submitCandidates, log } = options;
  const newChat = options.newChat ?? true;
  const previousClipboard = await vscode.env.clipboard.readText();

  try {
    await vscode.env.clipboard.writeText(prompt);
    log("clipboard written");

    if (strategy === "clipboard-only") {
      return {
        usedStrategy: "clipboard-only",
        submitted: false,
        triedSubmitCommands: [],
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
        };
      }
      await delay(250);
    } else {
      openedWith = "current-chat";
    }

    // Focus the composer input before paste/submit.
    await tryCommand("composer.focusComposer", log);
    await delay(150);

    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    log(`pasted after ${openedWith}`);
    await delay(200);

    const shouldSubmit =
      strategy === "auto" || strategy === "composer.newAgentChat+paste+submit";
    const triedSubmitCommands: string[] = [];
    let submitted = false;
    let submitMethod: string | undefined;

    if (shouldSubmit) {
      // 1) Try known command IDs, but do NOT trust "did not throw" as success.
      //    We still attempt them in case a future Cursor version wires them up.
      for (const commandId of [
        "composer.startGeneration",
        "composer.startComposerPrompt",
        ...submitCandidates,
        "workbench.action.chat.submit",
      ]) {
        if (triedSubmitCommands.includes(commandId)) continue;
        triedSubmitCommands.push(commandId);
        await tryCommand(commandId, log);
      }

      // 2) Reliable path for Cursor: OS-level Enter while composer is focused.
      await tryCommand("composer.focusComposer", log);
      await delay(100);
      const enterOk = await sendEnterKey(log);
      if (enterOk) {
        submitted = true;
        submitMethod = "os-enter";
        log("submitted via OS Enter key simulation");
      } else {
        log("OS Enter simulation failed");
      }
    }

    return {
      usedStrategy: `${openedWith}+paste${submitted ? `+${submitMethod}` : ""}`,
      submitted,
      submitMethod,
      triedSubmitCommands,
      openedWith,
    };
  } finally {
    // Restore clipboard after paste+submit have had time to consume it.
    await delay(300);
    try {
      await vscode.env.clipboard.writeText(previousClipboard);
    } catch {
      // ignore
    }
  }
}

export async function sendEnterKey(log: (message: string) => void): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // SendKeys targets the foreground window; Cursor should already be focused.
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
      ].join("; ");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 5000 },
      );
      return true;
    }

    if (platform === "darwin") {
      await execFileAsync("osascript", ["-e", 'tell application "System Events" to keystroke return'], {
        timeout: 5000,
      });
      return true;
    }

    // Linux
    try {
      await execFileAsync("xdotool", ["key", "Return"], { timeout: 5000 });
      return true;
    } catch {
      log("xdotool not available; install xdotool for Linux auto-submit");
      return false;
    }
  } catch (error) {
    log(`sendEnterKey failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
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
