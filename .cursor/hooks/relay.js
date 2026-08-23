#!/usr/bin/env node
/**
 * Cursor hook relay — reads JSON on stdin, POSTs to the local voice service.
 *
 * Usage from .cursor/hooks.json:
 *   { "command": "node .cursor/hooks/relay.js after-agent-response" }
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const KIND = process.argv[2] || "after-agent-response";
const PORT = Number(process.env.VOICE_CURSOR_PORT || 4738);
const HOST = process.env.VOICE_CURSOR_HOST || "127.0.0.1";
const LOG_PATH = path.join(__dirname, "..", "spike-events.jsonl");

function routeFor(kind) {
  if (kind === "stop") return "/hooks/stop";
  return "/hooks/after-agent-response";
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

  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind: KIND,
    payload,
  });
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // ignore log failures
  }

  const body = JSON.stringify(payload);
  await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: routeFor(KIND),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });

  // Observe-only hooks: empty/ok JSON is fine.
  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
  process.exit(0);
});
