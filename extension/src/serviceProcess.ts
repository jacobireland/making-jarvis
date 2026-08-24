import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

let managedChild: ChildProcess | null = null;
let startInFlight: Promise<{ ok: boolean; startedByUs: boolean; detail: string }> | null =
  null;

/** Repo root that contains `voice-service/` (workspace or parent of extension/). */
export function resolveRepoRoot(extensionPath: string): string | undefined {
  const candidates = [
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    path.resolve(extensionPath, ".."),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    const pkg = path.join(candidate, "voice-service", "package.json");
    if (fs.existsSync(pkg)) return candidate;
  }
  return undefined;
}

export async function isServiceHealthy(serviceUrl: string): Promise<boolean> {
  const base = serviceUrl.replace(/\/$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function serviceEntry(repoRoot: string): string {
  return path.join(repoRoot, "voice-service", "dist", "index.js");
}

/**
 * Ensure the local voice service is reachable. Optionally spawn it once if we
 * manage the process (killed on extension deactivate).
 */
export async function ensureVoiceService(options: {
  extensionPath: string;
  serviceUrl: string;
  autoStart: boolean;
  log: (msg: string) => void;
}): Promise<{ ok: boolean; startedByUs: boolean; detail: string }> {
  if (await isServiceHealthy(options.serviceUrl)) {
    return { ok: true, startedByUs: false, detail: "already-running" };
  }

  if (!options.autoStart) {
    return {
      ok: false,
      startedByUs: false,
      detail: "auto-start disabled — run npm run service",
    };
  }

  if (startInFlight) return startInFlight;

  startInFlight = (async () => {
    try {
      // Another attempt may have come up while we waited.
      if (await isServiceHealthy(options.serviceUrl)) {
        return { ok: true, startedByUs: false, detail: "already-running" };
      }

      // If we already spawned a child, just wait for health.
      if (managedChild && managedChild.exitCode === null) {
        options.log("[service] waiting for managed voice-service to become healthy…");
        const ok = await waitForHealth(options.serviceUrl, 12_000);
        return {
          ok,
          startedByUs: true,
          detail: ok ? "managed-ready" : "managed-not-ready",
        };
      }

      const root = resolveRepoRoot(options.extensionPath);
      if (!root) {
        options.log(
          "[service] could not find repo root (need voice-service/ next to workspace or extension)",
        );
        return { ok: false, startedByUs: false, detail: "repo-root-missing" };
      }

      const entry = serviceEntry(root);
      if (!fs.existsSync(entry)) {
        options.log(
          `[service] missing ${entry} — run npm run build in the repo root`,
        );
        return { ok: false, startedByUs: false, detail: "not-built" };
      }

      options.log(`[service] auto-starting node ${entry} (cwd=${root})`);
      const child = spawn(process.execPath, [entry], {
        cwd: root,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      managedChild = child;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const line = String(chunk).trim();
        if (line) options.log(`[service:out] ${line.slice(0, 300)}`);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const line = String(chunk).trim();
        if (line) options.log(`[service:err] ${line.slice(0, 300)}`);
      });
      child.on("exit", (code, signal) => {
        options.log(`[service] managed process exited code=${code} signal=${signal}`);
        if (managedChild === child) managedChild = null;
      });

      const ok = await waitForHealth(options.serviceUrl, 15_000);
      if (!ok) {
        options.log("[service] auto-start timed out waiting for /health");
        return { ok: false, startedByUs: true, detail: "start-timeout" };
      }
      options.log("[service] auto-start healthy");
      return { ok: true, startedByUs: true, detail: "started" };
    } finally {
      startInFlight = null;
    }
  })();

  return startInFlight;
}

async function waitForHealth(serviceUrl: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isServiceHealthy(serviceUrl)) return true;
    await delay(250);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stop the process only if this extension started it. */
export function stopManagedVoiceService(log?: (msg: string) => void): void {
  const child = managedChild;
  if (!child) return;
  managedChild = null;
  try {
    log?.("[service] stopping managed voice-service");
    child.kill();
  } catch {
    // ignore
  }
}

export function isManagingVoiceService(): boolean {
  return managedChild !== null && managedChild.exitCode === null;
}
