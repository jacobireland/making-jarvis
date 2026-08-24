import * as vscode from "vscode";
import WebSocket from "ws";
import type { AgentResponseEvent, VoiceCursorEvent } from "@voice-cursor/shared";
import { injectPrompt, warmSendEnterHost, type InjectionStrategy, type SubmitChord } from "./inject";
import { inventoryAgentCommands, writeInventoryMarkdown } from "./inventory";
import { diagnoseCapture } from "./diagnose";
import { waitForCapturedMarker } from "./proveSubmit";
import { notifyAgentResponse, notifyTtsDone } from "./agentWait";
import { runOneShotTalk, startPushToTalk, stopPushToTalkAndSend } from "./oneShot";
import { showStickyListeningUi, signalListenEnd } from "./listenUi";
import {
  ensureVoiceService,
  stopManagedVoiceService,
} from "./serviceProcess";

const OUTPUT_CHANNEL = "Voice Cursor";
const DEFAULT_TEST_PROMPT = "SPIKE: reply with exactly PONG and nothing else.";

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let socket: WebSocket | undefined;
let lastAgentResponse: AgentResponseEvent | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempt = 0;
let extensionPath = "";
let oneShotRunning = false;
/** When true, Stop status-bar click only ends the sticky UI; caller runs send. */
let deferStopToCaller = false;
/** After first same-thread inject in this session, keep using current chat. */
let sessionOpenedAgentChat = false;

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
      const newChat = resolveNewChat();
      output.appendLine(`[inject] strategy=${strategy} newChat=${newChat}`);
      output.appendLine(`[inject] prompt=${prompt}`);
      try {
        const result = await injectPrompt(prompt, {
          strategy,
          submitCandidates: getSubmitCandidates(),
          submitChord: getSubmitChord(),
          newChat,
          log: (msg) => output.appendLine(`[inject] ${msg}`),
          extensionPath,
        });
        noteChatOpened(result.openedWith);
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
      const ensured = await ensureVoiceService({
        extensionPath,
        serviceUrl: serviceBase(),
        autoStart: isAutoStartEnabled(),
        log: (msg) => output.appendLine(msg),
      });
      output.appendLine(`[service] ensure=${JSON.stringify(ensured)}`);
      connectSocket();
      const health = await getJson("/health");
      output.appendLine(`[service] health=${JSON.stringify(health)}`);
      vscode.window.showInformationMessage(
        ensured.ok
          ? "Voice Cursor: voice service connected"
          : "Voice Cursor: service still unreachable — run npm run build && npm run service",
      );
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
          submitChord: getSubmitChord(),
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
        const newChat = resolveNewChat();
        await runOneShotTalk({
          serviceBase: serviceBase(),
          extensionPath,
          listenSeconds: vscode.workspace
            .getConfiguration("voiceCursor")
            .get<number>("listenSeconds", 7),
          newChat,
          submitCandidates: getSubmitCandidates(),
          submitChord: getSubmitChord(),
          confirmTranscript: isConfirmTranscriptEnabled(),
          quietUi: isQuietUiEnabled(),
          log: (msg) => output.appendLine(msg),
          setStatus,
          onListening: () => {
            deferStopToCaller = true;
            status.command = "voiceCursor.stopListeningAndSend";
            status.tooltip = "Click to stop listening and send";
            status.text = "$(mic) Voice Cursor: listening (click to send)";
          },
          onInjected: (openedWith) => noteChatOpened(openedWith),
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
        const newChat = resolveNewChat();
        const confirmTranscript = isConfirmTranscriptEnabled();
        await stopPushToTalkAndSend({
          serviceBase: serviceBase(),
          extensionPath,
          newChat,
          submitCandidates: getSubmitCandidates(),
          submitChord: getSubmitChord(),
          confirmTranscript,
          quietUi: isQuietUiEnabled(),
          log: (msg) => output.appendLine(msg),
          setStatus,
          onInjected: (openedWith) => noteChatOpened(openedWith),
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
      if (!isQuietUiEnabled()) {
        void vscode.window.showInformationMessage("Voice Cursor: listening cancelled");
      }
    }),
  );

  void bootstrapServiceAndSocket();
  void warmSendEnterHost(extensionPath).then(() => {
    output.appendLine("[inject] send-enter host warmed");
  });
  output.appendLine("Voice Cursor activated (push-to-talk).");
  output.appendLine(
    isAutoStartEnabled()
      ? "1) Voice service auto-starts if needed (or keep npm run service running)"
      : "1) Start service: npm run service",
  );
  output.appendLine("2) Start Listening or One-Shot Talk");
  output.appendLine("3) While listening: click status-bar mic to Stop & Send");
  output.appendLine("   (sticky notification also stays up — Cancel there to abort)");
  output.appendLine(
    `Chat mode: ${
      vscode.workspace
        .getConfiguration("voiceCursor")
        .get<boolean>("oneShotNewChat", false)
        ? "new Agent chat each turn"
        : "same thread (opens one chat on first turn this session)"
    }`,
  );
}

export function deactivate(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  stopManagedVoiceService((msg) => {
    try {
      output?.appendLine(msg);
    } catch {
      // ignore
    }
  });
}

function getStrategy(): InjectionStrategy {
  const value = vscode.workspace
    .getConfiguration("voiceCursor")
    .get<string>("injectionStrategy", "auto");
  return value as InjectionStrategy;
}

function getSubmitChord(): SubmitChord {
  const value = vscode.workspace
    .getConfiguration("voiceCursor")
    .get<string>("submitChord", "enter");
  if (value === "ctrl-enter" || value === "both" || value === "enter") return value;
  return "enter";
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

function isAutoStartEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<boolean>("autoStartService", true);
}

function isConfirmTranscriptEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<boolean>("confirmTranscript", false);
}

function isQuietUiEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<boolean>("quietUi", true);
}

/**
 * New chat each turn if `oneShotNewChat` is true.
 * Otherwise: open one Agent chat on the first turn this session, then same thread.
 */
function resolveNewChat(): boolean {
  const eachTurn = vscode.workspace
    .getConfiguration("voiceCursor")
    .get<boolean>("oneShotNewChat", false);
  if (eachTurn) return true;
  return !sessionOpenedAgentChat;
}

function noteChatOpened(openedWith?: string): void {
  if (!openedWith) return;
  // Any successful inject into Agent counts as "we have a thread".
  sessionOpenedAgentChat = true;
}

async function bootstrapServiceAndSocket(): Promise<void> {
  const ensured = await ensureVoiceService({
    extensionPath,
    serviceUrl: serviceBase(),
    autoStart: isAutoStartEnabled(),
    log: (msg) => output.appendLine(msg),
  });
  output.appendLine(`[service] bootstrap=${JSON.stringify(ensured)}`);
  connectSocket();
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
  if (reconnectAttempt === 0) {
    output.appendLine(`[ws] connecting ${url}`);
  }
  const next = new WebSocket(url);
  socket = next;

  next.on("open", () => {
    reconnectAttempt = 0;
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
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 4));
    reconnectAttempt += 1;
    if (reconnectAttempt <= 3 || reconnectAttempt % 5 === 0) {
      output.appendLine(
        `[ws] closed; voice service not reachable — retry in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}).` +
          (isAutoStartEnabled()
            ? " Auto-start will retry."
            : " Keep npm run service running."),
      );
    }
    setStatus("error", "voice service disconnected");
    reconnectTimer = setTimeout(() => {
      void (async () => {
        // Periodically try to bring the service back if we manage it / auto-start.
        if (isAutoStartEnabled() && (reconnectAttempt === 1 || reconnectAttempt % 3 === 0)) {
          await ensureVoiceService({
            extensionPath,
            serviceUrl: serviceBase(),
            autoStart: true,
            log: (msg) => output.appendLine(msg),
          });
        }
        connectSocket();
      })();
    }, delay);
  });

  next.on("error", (error) => {
    // close handler schedules retry; avoid duplicating every ECONNREFUSED line
    if (reconnectAttempt === 0) {
      output.appendLine(`[ws] error: ${error.message}`);
    }
  });
}

function handleEvent(event: VoiceCursorEvent): void {
  if (event.type === "agent_thought") {
    output.appendLine(
      `[agent_thought] spokenChars=${event.spokenText.length} rawChars=${event.text.length} durationMs=${event.durationMs ?? "n/a"} ${event.spokenText.slice(0, 160)}`,
    );
    return;
  }
  if (event.type === "agent_response") {
    lastAgentResponse = event;
    notifyAgentResponse(event);
    setStatus("idle", "response captured");
    output.appendLine(
      `[agent_response] spokenChars=${event.spokenText.length} rawChars=${event.text.length} ${event.spokenText.slice(0, 160)}`,
    );
    // Skip toast during push-to-talk / when quiet UI is on — status bar + TTS are enough.
    if (!oneShotRunning && !isQuietUiEnabled()) {
      void vscode.window.showInformationMessage(
        `Voice Cursor captured: ${event.spokenText.slice(0, 120)}`,
      );
    }
    return;
  }
  if (event.type === "tts_done") {
    notifyTtsDone(event);
    output.appendLine(
      `[tts_done] ok=${event.ok} source=${event.source ?? "?"} engine=${event.engine ?? "?"} firstAudioMs=${event.firstAudioMs ?? "n/a"} totalMs=${event.totalMs ?? "n/a"}`,
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
