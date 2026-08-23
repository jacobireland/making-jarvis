import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type DiagnoseReport = {
  workspaceRoot?: string;
  serviceHealth?: unknown;
  serviceError?: string;
  hooksJsonExists: boolean;
  relayExists: boolean;
  spikeEventsExists: boolean;
  spikeEventsPreview: string[];
  tempHookLogExists: boolean;
  tempHookLogPreview: string[];
  guidance: string[];
};

export async function diagnoseCapture(serviceBase: string): Promise<DiagnoseReport> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const hooksJson = root ? path.join(root, ".cursor", "hooks.json") : undefined;
  const relay = root ? path.join(root, ".cursor", "hooks", "relay.js") : undefined;
  const spike = root ? path.join(root, ".cursor", "spike-events.jsonl") : undefined;
  const tempLog = path.join(os.tmpdir(), "voice-cursor-hooks.log");

  const report: DiagnoseReport = {
    workspaceRoot: root,
    hooksJsonExists: Boolean(hooksJson && fs.existsSync(hooksJson)),
    relayExists: Boolean(relay && fs.existsSync(relay)),
    spikeEventsExists: Boolean(spike && fs.existsSync(spike)),
    spikeEventsPreview: spike ? tailLines(spike, 8) : [],
    tempHookLogExists: fs.existsSync(tempLog),
    tempHookLogPreview: tailLines(tempLog, 8),
    guidance: [],
  };

  try {
    const res = await fetch(`${serviceBase.replace(/\/$/, "")}/health`);
    report.serviceHealth = await res.json();
  } catch (error) {
    report.serviceError = error instanceof Error ? error.message : String(error);
  }

  if (report.serviceError) {
    report.guidance.push("Voice service is not reachable. Run `npm run service` in the repo root.");
  }
  if (!report.hooksJsonExists || !report.relayExists) {
    report.guidance.push("Missing `.cursor/hooks.json` or relay script. Pull latest PR branch.");
  }
  if (!report.spikeEventsExists && !report.tempHookLogExists) {
    report.guidance.push(
      "No hook log found. Cursor hooks are probably not running. Common fixes: trust the workspace, reload window, ensure `node` is on PATH for GUI apps (run scripts/fix-hooks-windows.ps1).",
    );
  } else if (report.spikeEventsExists || report.tempHookLogExists) {
    report.guidance.push(
      "Hooks are firing (log found). If extension still shows nothing, reconnect the voice service and confirm /events has agent_response.",
    );
  }

  return report;
}

function tailLines(filePath: string, count: number): string[] {
  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    if (!text) return [];
    return text.split(/\r?\n/).slice(-count);
  } catch {
    return [];
  }
}
