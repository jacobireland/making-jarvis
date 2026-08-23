import * as vscode from "vscode";

export type InjectionStrategy =
  | "auto"
  | "composer.newAgentChat+paste+submit"
  | "composer.newAgentChat+paste"
  | "clipboard-only";

export type InjectResult = {
  usedStrategy: string;
  submitted: boolean;
  triedSubmitCommands: string[];
};

export async function injectPrompt(
  prompt: string,
  options: {
    strategy: InjectionStrategy;
    submitCandidates: string[];
    log: (message: string) => void;
  },
): Promise<InjectResult> {
  const { strategy, submitCandidates, log } = options;
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

    const openCandidates = [
      "composer.newAgentChat",
      "composer.createNewComposerTab",
      "aichat.newchat",
      "workbench.action.chat.open",
    ];
    const openedWith = await tryFirstAvailableCommand(openCandidates, log);
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

    await delay(150);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    log(`pasted after ${openedWith}`);

    const shouldSubmit =
      strategy === "auto" || strategy === "composer.newAgentChat+paste+submit";
    const triedSubmitCommands: string[] = [];
    let submitted = false;

    if (shouldSubmit) {
      for (const commandId of submitCandidates) {
        triedSubmitCommands.push(commandId);
        const ok = await tryCommand(commandId, log);
        if (ok) {
          submitted = true;
          log(`submitted via ${commandId}`);
          break;
        }
      }
      if (!submitted) {
        log("no submit command succeeded; prompt is pasted — press Enter in Agent chat");
      }
    }

    return {
      usedStrategy: `${openedWith}+paste${submitted ? "+submit" : ""}`,
      submitted,
      triedSubmitCommands,
    };
  } finally {
    // Best-effort restore so we don't permanently clobber user clipboard.
    await delay(50);
    try {
      await vscode.env.clipboard.writeText(previousClipboard);
    } catch {
      // ignore
    }
  }
}

async function tryFirstAvailableCommand(
  commandIds: string[],
  log: (message: string) => void,
): Promise<string | undefined> {
  for (const id of commandIds) {
    if (await tryCommand(id, log)) return id;
  }
  return undefined;
}

async function tryCommand(commandId: string, log: (message: string) => void): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(commandId);
    return true;
  } catch (error) {
    log(`command failed: ${commandId} (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
