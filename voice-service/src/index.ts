import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  toSpokenText,
  type AgentResponseEvent,
  type HealthResponse,
  type VoiceCursorEvent,
  type VoiceCursorState,
} from "@voice-cursor/shared";

const PORT = Number(process.env.VOICE_CURSOR_PORT ?? 4738);
const HOST = process.env.VOICE_CURSOR_HOST ?? "127.0.0.1";
const VERSION = "0.1.0";

let state: VoiceCursorState = "idle";
const events: VoiceCursorEvent[] = [];
const MAX_EVENTS = 200;
const sockets = new Set<WebSocket>();

function pushEvent(event: VoiceCursorEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function setState(next: VoiceCursorState, detail?: string): void {
  state = next;
  pushEvent({
    type: "state",
    state: next,
    detail,
    at: new Date().toISOString(),
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function asAgentResponse(body: Record<string, unknown>): AgentResponseEvent {
  const text =
    (typeof body.text === "string" && body.text) ||
    (typeof body.response === "string" && body.response) ||
    (typeof body.content === "string" && body.content) ||
    "";

  return {
    type: "agent_response",
    text,
    spokenText: toSpokenText(text),
    conversationId:
      typeof body.conversation_id === "string"
        ? body.conversation_id
        : typeof body.conversationId === "string"
          ? body.conversationId
          : undefined,
    generationId:
      typeof body.generation_id === "string"
        ? body.generation_id
        : typeof body.generationId === "string"
          ? body.generationId
          : undefined,
    receivedAt: new Date().toISOString(),
    raw: body,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const last = [...events].reverse().find((e) => e.type === "agent_response") as
        | AgentResponseEvent
        | undefined;
      const body: HealthResponse = {
        ok: true,
        service: "voice-cursor",
        version: VERSION,
        state,
        lastAgentResponseAt: last?.receivedAt,
        eventCount: events.length,
      };
      json(res, 200, body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), MAX_EVENTS);
      json(res, 200, { events: events.slice(-limit) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/hooks/session-start") {
      const body = (await readJson(req)) as Record<string, unknown>;
      pushEvent({
        type: "state",
        state: "idle",
        detail: "hooks sessionStart received",
        at: new Date().toISOString(),
      });
      console.log("[voice-cursor] sessionStart hook", body.session_id ?? "");
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/hooks/after-agent-response") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const event = asAgentResponse(body);
      pushEvent(event);
      setState("idle", "agent response received");
      console.log(
        "[voice-cursor] agent_response",
        event.spokenText.slice(0, 120),
        `(chars=${event.text.length})`,
      );
      json(res, 200, { ok: true, spokenText: event.spokenText });
      return;
    }

    if (req.method === "POST" && url.pathname === "/hooks/stop") {
      const body = (await readJson(req)) as Record<string, unknown>;
      pushEvent({
        type: "state",
        state: "idle",
        detail: "agent stop",
        at: new Date().toISOString(),
      });
      // Some Cursor versions may only emit useful text on stop; try capture.
      const maybeText =
        (typeof body.text === "string" && body.text) ||
        (typeof body.status === "string" && body.status) ||
        "";
      if (maybeText && maybeText.length > 2) {
        pushEvent(asAgentResponse({ ...body, text: maybeText }));
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/utterance") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        json(res, 400, { ok: false, error: "text required" });
        return;
      }
      pushEvent({
        type: "utterance",
        text,
        receivedAt: new Date().toISOString(),
      });
      setState("waiting_agent", text);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/state") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const next = body.state;
      if (
        next !== "idle" &&
        next !== "listening" &&
        next !== "transcribing" &&
        next !== "waiting_agent" &&
        next !== "speaking" &&
        next !== "paused" &&
        next !== "error"
      ) {
        json(res, 400, { ok: false, error: "invalid state" });
        return;
      }
      setState(next, typeof body.detail === "string" ? body.detail : undefined);
      json(res, 200, { ok: true, state });
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  sockets.add(socket);
  socket.send(
    JSON.stringify({
      type: "state",
      state,
      detail: "connected",
      at: new Date().toISOString(),
    } satisfies VoiceCursorEvent),
  );
  socket.on("close", () => sockets.delete(socket));
});

server.listen(PORT, HOST, () => {
  console.log(`[voice-cursor] listening on http://${HOST}:${PORT}`);
  console.log(`[voice-cursor] websocket ws://${HOST}:${PORT}/ws`);
});
