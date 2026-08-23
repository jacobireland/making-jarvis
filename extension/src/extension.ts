import * as vscode from "vscode";
import WebSocket from "ws";
import type { AgentResponseEvent, VoiceCursorEvent } from "@voice-cursor/shared";
import { injectPrompt, type InjectionStrategy } from "./inject";
import { inventoryAgentCommands, writeInventoryMarkdown } from "./inventory";
import { diagnoseCapture } from "./diagnose";

const OUTPUT_CHANNEL = "Voice Cursor";
const DEFAULT_TEST_PROMPT = "SPIKE: reply with exactly PONG and nothing else.";

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let socket: WebSocket | undefined;
let lastAgentResponse: AgentResponseEvent | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(unmute) Voice Cursor: idle";
  status.tooltip = "Voice Cursor Phase 1 spike";
  status.command = "voiceCursor.showLastResponse";
  status.show();

  context.subscriptions.push(output, status);

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.sendTestPrompt", async () => {
      const prompt = await vscode.window.showInputBox({
        title: "Voice Cursor test prompt",
        value: DEFAULT_TEST_PROMPT,
        prompt: "This will be injected into Cursor Agent via the selected strategy",
      });
      if (!prompt) return;

      setStatus("waiting_agent", "sending test prompt");
      await postJson("/utterance", { text: prompt });
      const strategy = getStrategy();
      output.appendLine(`[inject] strategy=${strategy}`);
      output.appendLine(`[inject] prompt=${prompt}`);
      try {
        const result = await injectPrompt(prompt, {
          strategy,
          submitCandidates: getSubmitCandidates(),
          log: (msg) => output.appendLine(`[inject] ${msg}`),
        });
        output.appendLine(`[inject] result=${JSON.stringify(result)}`);
        vscode.window.showInformationMessage(
          `Voice Cursor: injected via ${result.usedStrategy} (submit=${result.submitted})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus("error", message);
        output.appendLine(`[inject] ERROR ${message}`);
        vscode.window.showErrorMessage(`Voice Cursor inject failed: ${message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.inventoryCommands", async () => {
      output.appendLine("[inventory] scanning commands…");
      const report = await inventoryAgentCommands();
      const target = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? context.globalStorageUri,
        "docs",
        "spike-command-inventory.md",
      );
      // Prefer workspace docs/ when available.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      const file = workspaceRoot
        ? vscode.Uri.joinPath(workspaceRoot, "docs", "spike-command-inventory.md")
        : target;
      await writeInventoryMarkdown(file, report);
      output.appendLine(`[inventory] wrote ${file.fsPath}`);
      output.appendLine(`[inventory] matched ${report.matched.length} commands`);
      await vscode.window.showTextDocument(file);
      vscode.window.showInformationMessage(
        `Voice Cursor: inventoried ${report.matched.length} candidate commands`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.showLastResponse", async () => {
      if (!lastAgentResponse) {
        vscode.window.showInformationMessage("Voice Cursor: no agent response captured yet");
        return;
      }
      output.appendLine("----- last agent response -----");
      output.appendLine(lastAgentResponse.text);
      output.appendLine("----- spoken text -----");
      output.appendLine(lastAgentResponse.spokenText);
      output.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.reconnectService", async () => {
      connectSocket();
      const health = await getJson("/health");
      output.appendLine(`[service] health=${JSON.stringify(health)}`);
      vscode.window.showInformationMessage("Voice Cursor: reconnected to voice service");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.setInjectionStrategy", async () => {
      const picked = await vscode.window.showQuickPick(
        [
          "auto",
          "composer.newAgentChat+paste+submit",
          "composer.newAgentChat+paste",
          "clipboard-only",
        ],
        { title: "Prompt injection strategy" },
      );
      if (!picked) return;
      await vscode.workspace
        .getConfiguration("voiceCursor")
        .update("injectionStrategy", picked, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Voice Cursor: strategy set to ${picked}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.diagnoseCapture", async () => {
      output.appendLine("[diagnose] running…");
      const report = await diagnoseCapture(serviceBase());
      output.appendLine(JSON.stringify(report, null, 2));
      output.show(true);
      const summary = report.guidance[0] ?? "See Voice Cursor output channel for details.";
      vscode.window.showInformationMessage(`Voice Cursor diagnose: ${summary}`);
    }),
  );

  connectSocket();
  output.appendLine("Voice Cursor activated (Phase 1 spike).");
  output.appendLine("1) Start service: npm run service");
  output.appendLine("2) Run: Voice Cursor: Inventory Agent Commands");
  output.appendLine("3) Run: Voice Cursor: Send Test Prompt");
  output.appendLine("If capture fails: Voice Cursor: Diagnose Capture");
}

export function deactivate(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
}

function getStrategy(): InjectionStrategy {
  const value = vscode.workspace
    .getConfiguration("voiceCursor")
    .get<string>("injectionStrategy", "auto");
  return value as InjectionStrategy;
}

function getSubmitCandidates(): string[] {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<string[]>("submitCommandCandidates", [
      "composer.startComposerPrompt",
      "composer.submit",
      "workbench.action.chat.submit",
      "aichat.submit-chat",
    ]);
}

function serviceBase(): string {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<string>("serviceUrl", "http://127.0.0.1:4738")
    .replace(/\/$/, "");
}

function wsUrl(): string {
  const base = serviceBase();
  if (base.startsWith("https://")) return `${base.replace(/^https/, "wss")}/ws`;
  return `${base.replace(/^http/, "ws")}/ws`;
}

function setStatus(state: string, detail?: string): void {
  status.text = `$(unmute) Voice Cursor: ${state}`;
  status.tooltip = detail ?? "Voice Cursor";
}

function connectSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  try {
    socket?.close();
  } catch {
    // ignore
  }

  const url = wsUrl();
  output.appendLine(`[ws] connecting ${url}`);
  const next = new WebSocket(url);
  socket = next;

  next.on("open", () => {
    output.appendLine("[ws] connected");
    setStatus("idle", "connected to voice service");
  });

  next.on("message", (data) => {
    try {
      const event = JSON.parse(String(data)) as VoiceCursorEvent;
      handleEvent(event);
    } catch (error) {
      output.appendLine(`[ws] bad event: ${String(error)}`);
    }
  });

  next.on("close", () => {
    output.appendLine("[ws] closed; retrying in 2s");
    setStatus("error", "voice service disconnected");
    reconnectTimer = setTimeout(connectSocket, 2000);
  });

  next.on("error", (error) => {
    output.appendLine(`[ws] error: ${error.message}`);
  });
}

function handleEvent(event: VoiceCursorEvent): void {
  if (event.type === "agent_response") {
    lastAgentResponse = event;
    setStatus("idle", "response captured");
    output.appendLine(`[agent_response] ${event.spokenText}`);
    void vscode.window.showInformationMessage(
      `Voice Cursor captured: ${event.spokenText.slice(0, 120)}`,
    );
    return;
  }
  if (event.type === "state") {
    setStatus(event.state, event.detail);
    return;
  }
  if (event.type === "utterance") {
    output.appendLine(`[utterance] ${event.text}`);
  }
}

async function getJson(pathname: string): Promise<unknown> {
  const res = await fetch(`${serviceBase()}${pathname}`);
  return res.json();
}

async function postJson(pathname: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${serviceBase()}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
