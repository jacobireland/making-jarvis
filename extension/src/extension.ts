import * as vscode from "vscode";
import WebSocket from "ws";
import type { AgentResponseEvent, VoiceCursorEvent } from "@voice-cursor/shared";
import { injectPrompt, type InjectionStrategy } from "./inject";
import { inventoryAgentCommands, writeInventoryMarkdown } from "./inventory";
import { diagnoseCapture } from "./diagnose";
import { waitForCapturedMarker } from "./proveSubmit";
import { notifyAgentResponse, notifyTtsDone } from "./agentWait";
import { runOneShotTalk, startPushToTalk, stopPushToTalkAndSend } from "./oneShot";
import { showStickyListeningUi, signalListenEnd } from "./listenUi";

const OUTPUT_CHANNEL = "Voice Cursor";
const DEFAULT_TEST_PROMPT = "SPIKE: reply with exactly PONG and nothing else.";

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let socket: WebSocket | undefined;
let lastAgentResponse: AgentResponseEvent | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let extensionPath = "";
let oneShotRunning = false;
/** When true, Stop status-bar click only ends the sticky UI; caller runs send. */
let deferStopToCaller = false;

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(unmute) Voice Cursor: idle";
  status.tooltip = "Voice Cursor: Start Listening";
  status.command = "voiceCursor.startListening";
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
          extensionPath,
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

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.proveAutoSubmit", async () => {
      const marker = `VC${Date.now().toString(36).toUpperCase()}`;
      const prompt =
        `AUTO-SUBMIT PROOF: reply with exactly the token ${marker} and nothing else.`;
      output.appendLine(`[prove] starting marker=${marker}`);
      output.show(true);
      setStatus("waiting_agent", "proving auto-submit");

      const sinceIso = new Date().toISOString();
      await postJson("/utterance", { text: prompt });

      let injectResult;
      try {
        injectResult = await injectPrompt(prompt, {
          strategy: "auto",
          submitCandidates: getSubmitCandidates(),
          log: (msg) => output.appendLine(`[prove/inject] ${msg}`),
          newChat: true,
          extensionPath,
        });
        output.appendLine(`[prove] inject=${JSON.stringify(injectResult)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[prove] inject ERROR ${message}`);
        vscode.window.showErrorMessage(`Auto-submit proof failed at inject: ${message}`);
        setStatus("error", message);
        return;
      }

      vscode.window.showInformationMessage(
        `Submit gestures sent (${injectResult.submitMethod ?? "none"}). Waiting for captured marker ${marker} — do not press Enter…`,
      );

      const captured = await waitForCapturedMarker(serviceBase(), marker, {
        timeoutMs: 90_000,
        sinceIso,
      });

      if (!captured.ok) {
        output.appendLine("[prove] FAIL: no captured response with marker (agent may not have run)");
        output.appendLine(`[prove] inject details=${JSON.stringify(injectResult.details)}`);
        vscode.window.showErrorMessage(
          "Auto-submit proof FAILED: prompt was pasted but Agent did not run/capture. Do not proceed to mic/TTS yet.",
        );
        setStatus("error", "no capture after submit");
        return;
      }

      output.appendLine(`[prove] PASS captured=${captured.text} via=${injectResult.submitMethod}`);
      setStatus("idle", "auto-submit proved");
      vscode.window.showInformationMessage(
        `AUTO-SUBMIT PROVED (${injectResult.submitMethod}). Captured: ${captured.text}`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.oneShotTalk", async () => {
      if (oneShotRunning) {
        const pick = await vscode.window.showWarningMessage(
          "Voice Cursor is still finishing the previous turn.",
          "Cancel & Start Fresh",
          "Keep Waiting",
        );
        if (pick !== "Cancel & Start Fresh") return;
        try {
          await postJson("/stt/cancel", {});
        } catch {
          // ignore
        }
        signalListenEnd("cancel");
        oneShotRunning = false;
        deferStopToCaller = false;
      }
      oneShotRunning = true;
      output.show(true);
      try {
        const newChat = vscode.workspace
          .getConfiguration("voiceCursor")
          .get<boolean>("oneShotNewChat", true);
        await runOneShotTalk({
          serviceBase: serviceBase(),
          extensionPath,
          listenSeconds: vscode.workspace
            .getConfiguration("voiceCursor")
            .get<number>("listenSeconds", 7),
          newChat,
          submitCandidates: getSubmitCandidates(),
          log: (msg) => output.appendLine(msg),
          setStatus,
          onListening: () => {
            deferStopToCaller = true;
            status.command = "voiceCursor.stopListeningAndSend";
            status.tooltip = "Click to stop listening and send";
            status.text = "$(mic) Voice Cursor: listening (click to send)";
          },
        });
      } finally {
        deferStopToCaller = false;
        oneShotRunning = false;
        status.command = "voiceCursor.startListening";
        status.tooltip = "Voice Cursor: Start Listening";
        status.text = "$(unmute) Voice Cursor: idle";
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.startListening", async () => {
      if (oneShotRunning) {
        const pick = await vscode.window.showWarningMessage(
          "Voice Cursor is still finishing the previous turn (waiting on Agent/TTS).",
          "Cancel & Start Fresh",
          "Keep Waiting",
        );
        if (pick !== "Cancel & Start Fresh") return;
        try {
          await postJson("/stt/cancel", {});
        } catch {
          // ignore
        }
        signalListenEnd("cancel");
        oneShotRunning = false;
        deferStopToCaller = false;
      }
      output.show(true);
      const ok = await startPushToTalk({
        serviceBase: serviceBase(),
        log: (msg) => output.appendLine(msg),
        setStatus,
      });
      if (!ok) return;

      status.command = "voiceCursor.stopListeningAndSend";
      status.tooltip = "Click to stop listening and send";
      status.text = "$(mic) Voice Cursor: listening (click to send)";

      // Sticky progress — does not vanish like a toast.
      void showStickyListeningUi({
        onCancel: async () => {
          try {
            await postJson("/stt/cancel", {});
          } catch {
            // ignore
          }
          setStatus("idle", "cancelled");
          status.command = "voiceCursor.startListening";
          status.tooltip = "Voice Cursor: Start Listening";
          status.text = "$(unmute) Voice Cursor: idle";
        },
      }).then((action) => {
        if (action === "send") {
          // stopListeningAndSend is already running from the status-bar click
          return;
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.stopListeningAndSend", async () => {
      // Always dismiss sticky listening UI first.
      signalListenEnd("send");

      if (deferStopToCaller) {
        // One-Shot owns the send path after the sticky UI resolves.
        return;
      }

      if (oneShotRunning) {
        vscode.window.showWarningMessage(
          "Voice Cursor: already sending this turn. Use Cancel Listening to abort.",
        );
        return;
      }
      oneShotRunning = true;
      output.show(true);
      try {
        const newChat = vscode.workspace
          .getConfiguration("voiceCursor")
          .get<boolean>("oneShotNewChat", true);
        const confirmTranscript = vscode.workspace
          .getConfiguration("voiceCursor")
          .get<boolean>("confirmTranscript", true);
        await stopPushToTalkAndSend({
          serviceBase: serviceBase(),
          extensionPath,
          newChat,
          submitCandidates: getSubmitCandidates(),
          confirmTranscript,
          log: (msg) => output.appendLine(msg),
          setStatus,
        });
      } finally {
        oneShotRunning = false;
        status.command = "voiceCursor.startListening";
        status.tooltip = "Voice Cursor: Start Listening";
        status.text = "$(unmute) Voice Cursor: idle";
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.cancelListening", async () => {
      try {
        await postJson("/stt/cancel", {});
      } catch {
        // ignore
      }
      signalListenEnd("cancel");
      deferStopToCaller = false;
      oneShotRunning = false;
      setStatus("idle", "cancelled");
      status.command = "voiceCursor.startListening";
      status.tooltip = "Voice Cursor: Start Listening";
      status.text = "$(unmute) Voice Cursor: idle";
      vscode.window.showInformationMessage("Voice Cursor: listening cancelled");
    }),
  );

  connectSocket();
  output.appendLine("Voice Cursor activated (push-to-talk).");
  output.appendLine("1) Start service: npm run service");
  output.appendLine("2) Start Listening or One-Shot Talk");
  output.appendLine("3) While listening: click status-bar mic to Stop & Send");
  output.appendLine("   (sticky notification also stays up — Cancel there to abort)");
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
    notifyAgentResponse(event);
    setStatus("idle", "response captured");
    output.appendLine(`[agent_response] ${event.spokenText}`);
    // Skip toast during push-to-talk — it adds noise while TTS is starting.
    if (!oneShotRunning) {
      void vscode.window.showInformationMessage(
        `Voice Cursor captured: ${event.spokenText.slice(0, 120)}`,
      );
    }
    return;
  }
  if (event.type === "tts_done") {
    notifyTtsDone(event);
    output.appendLine(
      `[tts_done] ok=${event.ok} engine=${event.engine ?? "?"} firstAudioMs=${event.firstAudioMs ?? "n/a"} totalMs=${event.totalMs ?? "n/a"}`,
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
