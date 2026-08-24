#!/usr/bin/env node
/**
 * Cursor hook relay — reads JSON on stdin, POSTs to the local voice service.
 *
 * Always writes a debug line so we can tell whether hooks fired at all.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const KIND = process.argv[2] || "after-agent-response";
const PORT = Number(process.env.VOICE_CURSOR_PORT || 4738);
const HOST = process.env.VOICE_CURSOR_HOST || "127.0.0.1";

const PROJECT_LOG = path.join(__dirname, "..", "spike-events.jsonl");
const DEBUG_LOG = path.join(os.tmpdir(), "voice-cursor-hooks.log");

function routeFor(kind) {
  if (kind === "stop") return "/hooks/stop";
  if (kind === "session-start") return "/hooks/session-start";
  if (kind === "after-agent-thought") return "/hooks/after-agent-thought";
  return "/hooks/after-agent-response";
}

function appendLog(filePath, line) {
  try {
    fs.appendFileSync(filePath, `${line}\n`);
  } catch {
    // ignore
  }
}

function debug(message, extra) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind: KIND,
    message,
    extra: extra ?? null,
  });
  appendLog(PROJECT_LOG, line);
  appendLog(DEBUG_LOG, line);
}

function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload.text,
    payload.response,
    payload.content,
    payload.message,
    payload.assistant_text,
    payload.final_text,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

async function postJson(pathname, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();

  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  const text = extractText(payload);
  debug("hook_invoked", {
    cwd: process.cwd(),
    hasText: Boolean(text),
    textPreview: text.slice(0, 120),
    payloadKeys: Object.keys(payload),
    node: process.version,
  });

  const result = await postJson(routeFor(KIND), {
    ...payload,
    text: text || payload.text || "",
    hookKind: KIND,
  });

  debug("post_result", result);

  // Observe-only hooks: empty JSON is fine.
  process.stdout.write("{}\n");
}

main().catch((error) => {
  debug("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.stdout.write("{}\n");
  process.exit(0);
});
