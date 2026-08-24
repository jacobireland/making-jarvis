import * as vscode from "vscode";
import { injectPrompt } from "./inject";
import { waitForAgentResponseFast, waitForTtsDoneFast } from "./agentWait";
import { showStickyListeningUi } from "./listenUi";
import { createTimedLogger } from "./log";
import type { SubmitChord } from "./inject";

export async function startPushToTalk(options: {
  serviceBase: string;
  log: (message: string) => void;
  setStatus: (state: string, detail?: string) => void;
  autoEnd?: boolean;
}): Promise<{ ok: boolean; autoEnd: boolean; mode?: string }> {
  const base = options.serviceBase.replace(/\/$/, "");
  const autoEnd = options.autoEnd !== false;
  options.setStatus("listening", autoEnd ? "pause to send" : "push-to-talk");
  options.log("[ptt] starting mic");
  try {
    const res = await fetch(`${base}/stt/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxSeconds: 120, autoEnd }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      id?: string;
      autoEnd?: boolean;
      mode?: string;
    };
    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `STT start HTTP ${res.status}`);
    }
    const resolvedAutoEnd = body.autoEnd === true;
    options.log(
      `[ptt] listening id=${body.id} mode=${body.mode ?? "?"} autoEnd=${resolvedAutoEnd}`,
    );
    return { ok: true, autoEnd: resolvedAutoEnd, mode: body.mode };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.setStatus("error", message);
    vscode.window.showErrorMessage(`Voice Cursor failed to start listening: ${message}`);
    return { ok: false, autoEnd: false };
  }
}

export async function stopPushToTalkAndSend(options: {
  serviceBase: string;
  extensionPath: string;
  newChat: boolean;
  submitCandidates: string[];
  confirmTranscript: boolean;
  quietUi?: boolean;
  submitChord?: SubmitChord;
  log: (message: string) => void;
  setStatus: (state: string, detail?: string) => void;
  onInjected?: (openedWith?: string) => void;
}): Promise<void> {
  const {
    serviceBase,
    extensionPath,
    newChat,
    submitCandidates,
    confirmTranscript,
    quietUi = true,
    submitChord = "enter",
    setStatus,
    onInjected,
  } = options;
  const turnStarted = Date.now();
  const log = createTimedLogger(options.log, { startedAt: turnStarted });
  const base = serviceBase.replace(/\/$/, "");

  setStatus("transcribing", "stopping mic");
  log("[ptt] stopping mic + transcribing");

  let transcript = "";
  try {
    const res = await fetch(`${base}/stt/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      text?: string;
      engine?: string;
      error?: string;
      durationMs?: number;
    };
    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `STT stop HTTP ${res.status}`);
    }
    transcript = (body.text ?? "").trim();
    log(
      `[ptt] stt engine=${body.engine} durationMs=${body.durationMs} text=${transcript || "(empty)"}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error", message);
    vscode.window.showErrorMessage(`Voice Cursor STT failed: ${message}`);
    return;
  }

  if (!transcript) {
    setStatus("idle", "no speech detected");
    vscode.window.showWarningMessage("Voice Cursor: no speech detected. Try again.");
    return;
  }

  if (confirmTranscript) {
    const use = await vscode.window.showInformationMessage(
      `Send to Agent: “${transcript.slice(0, 180)}${transcript.length > 180 ? "…" : ""}”?`,
      "Send",
      "Cancel",
    );
    if (use !== "Send") {
      setStatus("idle", "cancelled");
      return;
    }
  }

  const sinceIso = new Date().toISOString();
  setStatus("waiting_agent", transcript.slice(0, 60));
  await fetch(`${base}/utterance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: transcript }),
  });

  try {
    const injectResult = await injectPrompt(transcript, {
      strategy: "auto",
      submitCandidates,
      submitChord,
      log: (msg) => log(`[ptt/inject] ${msg}`),
      newChat,
      extensionPath,
    });
    onInjected?.(injectResult.openedWith);
    log(`[ptt] inject=${JSON.stringify(injectResult)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error", message);
    vscode.window.showErrorMessage(`Voice Cursor inject failed: ${message}`);
    return;
  }

  if (!quietUi) {
    void vscode.window.showInformationMessage("Sent to Agent. Waiting for reply…");
  }
  const waitStarted = Date.now();
  const captured = await waitForAgentResponseFast(base, {
    sinceIso,
    timeoutMs: 180_000,
  });
  log(`[ptt] agent reply waitMs=${Date.now() - waitStarted}`);

  if (!captured.ok || !captured.spokenText) {
    setStatus("error", "no agent reply captured");
    vscode.window.showErrorMessage(
      "Voice Cursor: Agent reply was not captured. Check hooks/service.",
    );
    return;
  }

  log(`[ptt] captured spoken=${captured.spokenText}`);
  setStatus("speaking", captured.spokenText.slice(0, 60));

  // Service auto-starts TTS on thought + final reply hooks (armed by /utterance).
  // Wait only for final-reply tts_done — thought speaks must not end the PTT turn.
  const ttsWaitStarted = Date.now();
  let tts = await waitForTtsDoneFast(base, {
    sinceIso,
    timeoutMs: 180_000,
  });

  if (!tts) {
    log("[ptt] auto-speak missing; falling back to /tts/speak");
    try {
      const ttsRes = await fetch(`${base}/tts/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: captured.spokenText }),
      });
      const ttsBody = (await ttsRes.json()) as {
        ok?: boolean;
        error?: string;
        engine?: string;
        firstAudioMs?: number;
        totalMs?: number;
      };
      if (ttsRes.status === 409) {
        tts = await waitForTtsDoneFast(base, { sinceIso, timeoutMs: 180_000 });
      } else if (!ttsRes.ok || !ttsBody.ok) {
        throw new Error(ttsBody.error ?? `TTS HTTP ${ttsRes.status}`);
      } else {
        tts = {
          type: "tts_done",
          ok: true,
          engine: ttsBody.engine,
          firstAudioMs: ttsBody.firstAudioMs,
          totalMs: ttsBody.totalMs,
          at: new Date().toISOString(),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error", message);
      vscode.window.showErrorMessage(
        `Voice Cursor captured reply but TTS failed: ${message}. Reply: ${captured.spokenText}`,
      );
      return;
    }
  }

  if (!tts || !tts.ok) {
    const message = tts?.error ?? "TTS did not complete";
    setStatus("error", message);
    vscode.window.showErrorMessage(
      `Voice Cursor captured reply but TTS failed: ${message}. Reply: ${captured.spokenText}`,
    );
    return;
  }

  log(
    `[ptt] tts engine=${tts.engine} firstAudioMs=${tts.firstAudioMs ?? "n/a"} totalMs=${tts.totalMs ?? "n/a"} (firstAudioMs = delay before sound; totalMs includes full playback) waitMs=${Date.now() - ttsWaitStarted}`,
  );
  setStatus("idle", "done");
  if (!quietUi) {
    void vscode.window.showInformationMessage("Voice Cursor: done.");
  }
}

/** One-shot = start listen, sticky UI until status-bar Stop & Send (or Cancel). */
export async function runOneShotTalk(options: {
  serviceBase: string;
  extensionPath: string;
  newChat: boolean;
  submitCandidates: string[];
  submitChord?: SubmitChord;
  confirmTranscript?: boolean;
  quietUi?: boolean;
  autoEnd?: boolean;
  log: (message: string) => void;
  setStatus: (state: string, detail?: string) => void;
  /** Called after mic starts so the extension can point the status bar at Stop. */
  onListening?: (info: { autoEnd: boolean; mode?: string }) => void;
  onInjected?: (openedWith?: string) => void;
}): Promise<void> {
  const started = await startPushToTalk({
    serviceBase: options.serviceBase,
    log: options.log,
    setStatus: options.setStatus,
    autoEnd: options.autoEnd,
  });
  if (!started.ok) return;

  options.onListening?.({ autoEnd: started.autoEnd, mode: started.mode });

  const action = await showStickyListeningUi({
    message: started.autoEnd
      ? "Pause when done — or click the status-bar mic to send now"
      : "Click the status-bar mic (“listening — click to send”) when done",
    onCancel: async () => {
      await fetch(`${options.serviceBase.replace(/\/$/, "")}/stt/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    },
  });

  if (action !== "send") {
    options.setStatus("idle", "cancelled");
    options.log("[ptt] listening cancelled from sticky UI");
    return;
  }

  await stopPushToTalkAndSend({
    serviceBase: options.serviceBase,
    extensionPath: options.extensionPath,
    newChat: options.newChat,
    submitCandidates: options.submitCandidates,
    submitChord: options.submitChord,
    confirmTranscript: options.confirmTranscript ?? false,
    quietUi: options.quietUi ?? true,
    log: options.log,
    setStatus: options.setStatus,
    onInjected: options.onInjected,
  });
}
