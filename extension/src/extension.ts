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
import { stampOutputChannel } from "./log";
import { shouldAutoRearm } from "./handsFree";

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
/** True while a listen session is armed (Start succeeded, not yet send/cancel). */
let listenArmed = false;
/** True from first successful Start until the user turns Voice Cursor off. */
let handsFreeSession = false;
/** Bumped on cancel so an in-flight turn will not auto-rearm. */
let listenSessionId = 0;

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  output = stampOutputChannel(vscode.window.createOutputChannel(OUTPUT_CHANNEL));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(unmute) Voice Cursor: idle";
  status.tooltip = "Click to turn listening on";
  status.command = "voiceCursor.toggleListening";
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      const file = vscode.Uri.joinPath(
        workspaceRoot ?? context.globalStorageUri,
        "docs",
        "spike-command-inventory.md",
      );
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
      if (!(await cancelInFlightTurnIfRequested("Voice Cursor is still finishing the previous turn."))) {
        return;
      }
      oneShotRunning = true;
      output.show(true);
      try {
        const newChat = resolveNewChat();
        await runOneShotTalk({
          serviceBase: serviceBase(),
          extensionPath,
          newChat,
          submitCandidates: getSubmitCandidates(),
          submitChord: getSubmitChord(),
          confirmTranscript: isConfirmTranscriptEnabled(),
          quietUi: isQuietUiEnabled(),
          autoEnd: isAutoEndEnabled(),
          log: (msg) => output.appendLine(msg),
          setStatus,
          onListening: (info) => {
            listenArmed = true;
            deferStopToCaller = true;
            applyListeningStatusBar(info.autoEnd);
          },
          onInjected: (openedWith) => noteChatOpened(openedWith),
        });
      } finally {
        deferStopToCaller = false;
        oneShotRunning = false;
        listenArmed = false;
        resetStatusBarIdle();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.toggleListening", async () => {
      if (listenArmed) {
        const pick = await vscode.window.showQuickPick(
          [
            {
              label: "$(mute) Turn off listening",
              description: "Stop the mic without sending",
              action: "off" as const,
            },
            {
              label: "$(send) Send now",
              description: "Stop and send what we heard",
              action: "send" as const,
            },
          ],
          {
            title: "Voice Cursor is listening",
            placeHolder: "Turn off, or send now",
            ignoreFocusOut: true,
          },
        );
        if (!pick) return;
        if (pick.action === "off") {
          await vscode.commands.executeCommand("voiceCursor.cancelListening");
        } else {
          await vscode.commands.executeCommand("voiceCursor.stopListeningAndSend");
        }
        return;
      }
      if (handsFreeSession || oneShotRunning) {
        await vscode.commands.executeCommand("voiceCursor.cancelListening");
        return;
      }
      await vscode.commands.executeCommand("voiceCursor.startListening");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.startListening", async () => {
      await beginListening("user");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.stopListeningAndSend", async () => {
      // Always dismiss sticky listening UI first.
      listenArmed = false;
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
      await finishTurnThenMaybeRearm();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voiceCursor.cancelListening", async () => {
      endHandsFreeSession();
      try {
        await postJson("/stt/cancel", {});
      } catch {
        // ignore
      }
      listenArmed = false;
      signalListenEnd("cancel");
      deferStopToCaller = false;
      oneShotRunning = false;
      setStatus("idle", "cancelled");
      resetStatusBarIdle();
      if (!isQuietUiEnabled()) {
        void vscode.window.showInformationMessage("Voice Cursor: listening cancelled");
      }
    }),
  );

  void bootstrapServiceAndSocket();
  void warmSendEnterHost(extensionPath).then(() => {
    output.appendLine("[inject] send-enter host warmed");
  });
  output.appendLine("Voice Cursor activated (push-to-talk + pause-to-send).");
  output.appendLine(
    isAutoStartEnabled()
      ? "1) Voice service auto-starts if needed (or keep npm run service running)"
      : "1) Start service: npm run service",
  );
  output.appendLine("2) Click the status-bar Voice Cursor item to turn listening on");
  output.appendLine(
    isAutoEndEnabled()
      ? "3) Speak, then pause — Flux auto-sends. Listening comes back on after the reply. Click the status-bar item to turn off, or send now."
      : "3) While listening: click the status-bar item to turn off or send. After the reply, listening comes back on.",
  );
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

function resetStatusBarIdle(): void {
  status.command = "voiceCursor.toggleListening";
  status.tooltip = handsFreeSession
    ? "Click to turn Voice Cursor off"
    : "Click to turn listening on";
  status.text = handsFreeSession
    ? "$(unmute) Voice Cursor: on"
    : "$(unmute) Voice Cursor: idle";
}

function endHandsFreeSession(): void {
  listenSessionId += 1;
  handsFreeSession = false;
  listenArmed = false;
}

async function beginListening(source: "user" | "rearm"): Promise<void> {
  if (listenArmed) return;
  if (source === "rearm" && !handsFreeSession) return;
  if (source === "user") {
    if (
      !(await cancelInFlightTurnIfRequested(
        "Voice Cursor is still finishing the previous turn (waiting on Agent/TTS).",
      ))
    ) {
      return;
    }
    output.show(true);
  }

  const started = await startPushToTalk({
    serviceBase: serviceBase(),
    log: (msg) => output.appendLine(msg),
    setStatus,
    autoEnd: isAutoEndEnabled(),
  });
  if (!started.ok) {
    if (source === "rearm") {
      output.appendLine("[ptt] auto-rearm failed");
    }
    return;
  }

  handsFreeSession = true;
  listenArmed = true;
  applyListeningStatusBar(started.autoEnd);
  if (source === "rearm") {
    output.appendLine("[ptt] auto-rearmed listening");
  }

  void showStickyListeningUi({
    message: started.autoEnd
      ? "Pause when done to send. Click the status-bar item to turn listening off, or send now."
      : "Click the status-bar item to turn listening off, or send now.",
    onCancel: async () => {
      endHandsFreeSession();
      try {
        await postJson("/stt/cancel", {});
      } catch {
        // ignore
      }
      setStatus("idle", "cancelled");
      resetStatusBarIdle();
    },
  }).then((action) => {
    if (action === "send") {
      return;
    }
  });
}

async function finishTurnThenMaybeRearm(): Promise<void> {
  const sessionId = listenSessionId;
  oneShotRunning = true;
  output.show(true);
  try {
    await stopPushToTalkAndSend({
      serviceBase: serviceBase(),
      extensionPath,
      newChat: resolveNewChat(),
      submitCandidates: getSubmitCandidates(),
      submitChord: getSubmitChord(),
      confirmTranscript: isConfirmTranscriptEnabled(),
      quietUi: isQuietUiEnabled(),
      quietEmpty: isAutoRearmEnabled() && handsFreeSession,
      log: (msg) => output.appendLine(msg),
      setStatus,
      onInjected: (openedWith) => noteChatOpened(openedWith),
    });
  } finally {
    oneShotRunning = false;
  }

  if (
    shouldAutoRearm({
      sessionEnabled: handsFreeSession,
      autoRearm: isAutoRearmEnabled(),
      cancelled: sessionId !== listenSessionId,
    })
  ) {
    output.appendLine("[ptt] auto-rearm after turn");
    await beginListening("rearm");
    return;
  }
  if (!listenArmed) resetStatusBarIdle();
}

/**
 * If a turn is in flight, ask to cancel it. Returns false when the user chooses to keep waiting.
 */
async function cancelInFlightTurnIfRequested(message: string): Promise<boolean> {
  if (!oneShotRunning) return true;
  const pick = await vscode.window.showWarningMessage(
    message,
    "Cancel & Start Fresh",
    "Keep Waiting",
  );
  if (pick !== "Cancel & Start Fresh") return false;
  try {
    await postJson("/stt/cancel", {});
  } catch {
    // ignore
  }
  signalListenEnd("cancel");
  oneShotRunning = false;
  deferStopToCaller = false;
  endHandsFreeSession();
  return true;
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

function isAutoEndEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<boolean>("autoEndUtterance", true);
}

function isAutoRearmEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("voiceCursor")
    .get<boolean>("autoRearmListening", true);
}

function applyListeningStatusBar(_autoEnd: boolean): void {
  status.command = "voiceCursor.toggleListening";
  status.tooltip = "Listening on — click to turn off, or send now";
  status.text = "$(mic) Voice Cursor: listening (click to turn off)";
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
  status.command = "voiceCursor.toggleListening";
  if (listenArmed) {
    applyListeningStatusBar(isAutoEndEnabled());
    if (detail && detail !== "pause to send" && detail !== "push-to-talk") {
      status.tooltip = `Listening on — click to turn off, or send now (${detail})`;
    }
    return;
  }
  if (handsFreeSession) {
    status.text = `$(unmute) Voice Cursor: ${state}`;
    status.tooltip = "Click to turn Voice Cursor off";
    return;
  }
  status.text = `$(unmute) Voice Cursor: ${state}`;
  status.tooltip =
    state === "idle"
      ? "Click to turn listening on"
      : (detail ?? "Voice Cursor");
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
    if (!listenArmed && !handsFreeSession) {
      setStatus("idle", "connected to voice service");
    }
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
  if (event.type === "utterance_end") {
    output.appendLine(
      `[utterance_end] engine=${event.engine ?? "?"} chars=${event.text.length} ${event.text.slice(0, 160)}`,
    );
    if (!listenArmed) return;
    listenArmed = false;
    signalListenEnd("send");
    if (!deferStopToCaller && !oneShotRunning) {
      void vscode.commands.executeCommand("voiceCursor.stopListeningAndSend");
    }
    return;
  }
  if (event.type === "agent_thought") {
    output.appendLine(
      `[agent_thought] spokenChars=${event.spokenText.length} rawChars=${event.text.length} durationMs=${event.durationMs ?? "n/a"} ${event.spokenText.slice(0, 160)}`,
    );
    return;
  }
  if (event.type === "agent_response") {
    lastAgentResponse = event;
    notifyAgentResponse(event);
    if (!oneShotRunning && !handsFreeSession) {
      setStatus("idle", "response captured");
    }
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
