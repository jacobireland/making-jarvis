import * as vscode from "vscode";
import { injectPrompt } from "./inject";
import { waitForNextAgentResponse } from "./proveSubmit";

export async function runOneShotTalk(options: {
  serviceBase: string;
  extensionPath: string;
  listenSeconds: number;
  newChat: boolean;
  submitCandidates: string[];
  log: (message: string) => void;
  setStatus: (state: string, detail?: string) => void;
}): Promise<void> {
  const {
    serviceBase,
    extensionPath,
    listenSeconds,
    newChat,
    submitCandidates,
    log,
    setStatus,
  } = options;
  const base = serviceBase.replace(/\/$/, "");

  const go = await vscode.window.showInformationMessage(
    `Voice Cursor: speak after OK. Listening ~${listenSeconds}s. Don't click away while sending.`,
    "OK — Start Listening",
    "Cancel",
  );
  if (go !== "OK — Start Listening") return;

  setStatus("listening", `~${listenSeconds}s`);
  log(`[oneshot] listening seconds=${listenSeconds}`);

  let transcript = "";
  try {
    const sttRes = await fetch(`${base}/stt/listen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds: listenSeconds }),
    });
    const sttBody = (await sttRes.json()) as {
      ok?: boolean;
      text?: string;
      engine?: string;
      error?: string;
    };
    if (!sttRes.ok || !sttBody.ok) {
      throw new Error(sttBody.error ?? `STT HTTP ${sttRes.status}`);
    }
    transcript = (sttBody.text ?? "").trim();
    log(`[oneshot] stt engine=${sttBody.engine} text=${transcript || "(empty)"}`);
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

  const use = await vscode.window.showInformationMessage(
    `Send to Agent: “${transcript.slice(0, 180)}${transcript.length > 180 ? "…" : ""}”?`,
    "Send",
    "Cancel",
  );
  if (use !== "Send") {
    setStatus("idle", "cancelled");
    return;
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
      log: (msg) => log(`[oneshot/inject] ${msg}`),
      newChat,
      extensionPath,
    });
    log(`[oneshot] inject=${JSON.stringify(injectResult)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error", message);
    vscode.window.showErrorMessage(`Voice Cursor inject failed: ${message}`);
    return;
  }

  vscode.window.showInformationMessage("Sent to Agent. Waiting for reply…");
  const captured = await waitForNextAgentResponse(base, {
    sinceIso,
    timeoutMs: 180_000,
  });

  if (!captured.ok || !captured.spokenText) {
    setStatus("error", "no agent reply captured");
    vscode.window.showErrorMessage(
      "Voice Cursor: Agent reply was not captured. Check hooks/service.",
    );
    return;
  }

  log(`[oneshot] captured spoken=${captured.spokenText}`);
  setStatus("speaking", captured.spokenText.slice(0, 60));

  try {
    const ttsRes = await fetch(`${base}/tts/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: captured.spokenText }),
    });
    const ttsBody = (await ttsRes.json()) as { ok?: boolean; error?: string; engine?: string };
    if (!ttsRes.ok || !ttsBody.ok) {
      throw new Error(ttsBody.error ?? `TTS HTTP ${ttsRes.status}`);
    }
    log(`[oneshot] tts engine=${ttsBody.engine}`);
    setStatus("idle", "oneshot complete");
    vscode.window.showInformationMessage("Voice Cursor: one-shot complete.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error", message);
    vscode.window.showErrorMessage(
      `Voice Cursor captured reply but TTS failed: ${message}. Reply: ${captured.spokenText}`,
    );
  }
}
