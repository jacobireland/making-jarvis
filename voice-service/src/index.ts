import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  toSpokenText,
  toSpokenThoughtText,
  type AgentResponseEvent,
  type AgentThoughtEvent,
  type HealthResponse,
  type VoiceCursorEvent,
  type VoiceCursorState,
} from "@voice-cursor/shared";
import {
  listenOnce,
  speakText,
  describeSttConfig,
  describeTtsConfig,
  warmTts,
  startMicSession,
  stopMicSessionAndTranscribe,
  cancelMicSession,
  getMicSessionStatus,
  loadDotEnv,
  logAuthHints,
} from "./speech";

loadDotEnv();

process.on("uncaughtException", (error) => {
  console.error("[voice-cursor] uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[voice-cursor] unhandledRejection:", reason);
});

const PORT = Number(process.env.VOICE_CURSOR_PORT ?? 4738);
const HOST = process.env.VOICE_CURSOR_HOST ?? "127.0.0.1";
const VERSION = "0.3.6";

let state: VoiceCursorState = "idle";
const events: VoiceCursorEvent[] = [];
const MAX_EVENTS = 200;
const sockets = new Set<WebSocket>();
let speechBusy = false;
/** After /utterance, speak thoughts + the next afterAgentResponse. */
let autoSpeakArmed = false;
/** Cursor sometimes double-fires afterAgentThought for the same block. */
let lastThoughtDedupeKey = "";
let lastThoughtDedupeAt = 0;

type SpeakJob = {
  text: string;
  source: string;
  done: (error?: unknown) => void;
};
const speakQueue: SpeakJob[] = [];

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

function isSpeakThoughtsEnabled(): boolean {
  const raw = (process.env.VOICE_CURSOR_SPEAK_THOUGHTS ?? "true").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function enqueueSpeak(text: string, source: string): Promise<void> {
  const cleaned = text.trim();
  if (!cleaned) return Promise.resolve();
  return new Promise((resolve, reject) => {
    speakQueue.push({
      text: cleaned,
      source,
      done: (error) => (error ? reject(error) : resolve()),
    });
    console.log(
      `[voice-cursor] speak queued source=${source} chars=${cleaned.length} depth=${speakQueue.length}`,
    );
    void drainSpeakQueue();
  });
}

async function drainSpeakQueue(): Promise<void> {
  if (speechBusy) return;
  const job = speakQueue.shift();
  if (!job) return;
  speechBusy = true;
  setState("speaking", `${job.source}: ${job.text.slice(0, 60)}`);
  const started = Date.now();
  try {
    const result = await speakText(job.text);
    console.log(
      `[voice-cursor] speak done source=${job.source} engine=${result.engine} firstAudioMs=${result.firstAudioMs ?? "n/a"} totalMs=${result.totalMs ?? Date.now() - started}`,
    );
    pushEvent({
      type: "tts_done",
      ok: true,
      engine: result.engine,
      voice: result.voice,
      firstAudioMs: result.firstAudioMs,
      totalMs: result.totalMs ?? Date.now() - started,
      source: job.source,
      at: new Date().toISOString(),
    });
    setState(speakQueue.length ? "speaking" : "idle", "spoke");
    job.done();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[voice-cursor] speak failed source=${job.source}: ${message}`);
    pushEvent({
      type: "tts_done",
      ok: false,
      error: message,
      totalMs: Date.now() - started,
      source: job.source,
      at: new Date().toISOString(),
    });
    setState("error", message);
    job.done(error);
  } finally {
    speechBusy = false;
    if (speakQueue.length) void drainSpeakQueue();
  }
}

async function speakAndAnnounce(text: string, source: string): Promise<void> {
  await enqueueSpeak(text, source);
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

function maxSpokenChars(): number {
  const maxSpoken = Number(process.env.VOICE_CURSOR_MAX_SPOKEN_CHARS ?? 2500);
  return Number.isFinite(maxSpoken) && maxSpoken > 200 ? maxSpoken : 2500;
}

function asAgentResponse(body: Record<string, unknown>): AgentResponseEvent {
  const text =
    (typeof body.text === "string" && body.text) ||
    (typeof body.response === "string" && body.response) ||
    (typeof body.content === "string" && body.content) ||
    "";

  const spokenText = toSpokenText(text, { maxChars: maxSpokenChars() });

  return {
    type: "agent_response",
    text,
    spokenText,
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

function isSpeakFullThoughtsEnabled(): boolean {
  const raw = (process.env.VOICE_CURSOR_SPEAK_FULL_THOUGHTS ?? "false").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function asAgentThought(body: Record<string, unknown>): AgentThoughtEvent {
  const text = typeof body.text === "string" ? body.text : "";
  const durationMs =
    typeof body.duration_ms === "number"
      ? body.duration_ms
      : typeof body.durationMs === "number"
        ? body.durationMs
        : undefined;
  // Default: chat preview one-liner only (not the expanded Thought body).
  const spokenText = toSpokenThoughtText(text, {
    maxChars: isSpeakFullThoughtsEnabled() ? maxSpokenChars() : 320,
    full: isSpeakFullThoughtsEnabled(),
  });
  return {
    type: "agent_thought",
    text,
    spokenText,
    durationMs,
    receivedAt: new Date().toISOString(),
    raw: body,
  };
}

function isDuplicateThought(event: AgentThoughtEvent): boolean {
  const key = `${event.durationMs ?? 0}:${event.text.length}:${event.text.slice(0, 240)}`;
  const now = Date.now();
  if (key === lastThoughtDedupeKey && now - lastThoughtDedupeAt < 4000) {
    return true;
  }
  lastThoughtDedupeKey = key;
  lastThoughtDedupeAt = now;
  return false;
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
      const body: HealthResponse & {
        stt?: ReturnType<typeof describeSttConfig>;
        tts?: ReturnType<typeof describeTtsConfig>;
      } = {
        ok: true,
        service: "voice-cursor",
        version: VERSION,
        state,
        lastAgentResponseAt: last?.receivedAt,
        eventCount: events.length,
        stt: describeSttConfig(),
        tts: describeTtsConfig(),
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

    if (req.method === "POST" && url.pathname === "/hooks/after-agent-thought") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const event = asAgentThought(body);
      if (isDuplicateThought(event)) {
        console.log(
          "[voice-cursor] agent_thought duplicate skipped",
          `chars=${event.text.length}`,
        );
        json(res, 200, { ok: true, duplicate: true });
        return;
      }
      pushEvent(event);
      const shouldSpeak =
        isSpeakThoughtsEnabled() && autoSpeakArmed && Boolean(event.spokenText.trim());
      console.log(
        "[voice-cursor] agent_thought",
        `rawChars=${event.text.length} spokenChars=${event.spokenText.length}`,
        `durationMs=${event.durationMs ?? "n/a"}`,
        `(autoSpeak=${autoSpeakArmed} speakThoughts=${isSpeakThoughtsEnabled()})`,
        event.spokenText.slice(0, 120),
      );
      // Keep autoSpeakArmed — final reply still comes via afterAgentResponse.
      json(res, 200, { ok: true, spokenText: event.spokenText, autoSpeak: shouldSpeak });
      if (shouldSpeak) {
        void enqueueSpeak(event.spokenText, "after-agent-thought").catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[voice-cursor] thought speak failed: ${message}`);
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/hooks/after-agent-response") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const event = asAgentResponse(body);
      pushEvent(event);
      const shouldAutoSpeak = autoSpeakArmed;
      autoSpeakArmed = false;
      console.log(
        "[voice-cursor] agent_response",
        `rawChars=${event.text.length} spokenChars=${event.spokenText.length}`,
        event.spokenText.slice(0, 120),
        `(autoSpeak=${shouldAutoSpeak} queue=${speakQueue.length})`,
      );
      // Reply to the hook immediately, then queue TTS behind any thought speaks.
      json(res, 200, { ok: true, spokenText: event.spokenText, autoSpeak: shouldAutoSpeak });
      if (shouldAutoSpeak && event.spokenText.trim()) {
        void speakAndAnnounce(event.spokenText, "after-agent-response");
      } else if (!speechBusy && speakQueue.length === 0) {
        setState("idle", "agent response received");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/hooks/stop") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const status = typeof body.status === "string" ? body.status : "unknown";
      pushEvent({
        type: "state",
        state: "idle",
        detail: `agent stop (${status})`,
        at: new Date().toISOString(),
      });
      // stop payload is { status, loop_count } — not assistant text.
      // Spoken replies come only from afterAgentResponse.
      console.log("[voice-cursor] stop", status);
      json(res, 200, { ok: true, status });
      return;
    }

    if (req.method === "POST" && url.pathname === "/utterance") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        json(res, 400, { ok: false, error: "text required" });
        return;
      }
      autoSpeakArmed = true;
      pushEvent({
        type: "utterance",
        text,
        receivedAt: new Date().toISOString(),
      });
      setState("waiting_agent", text);
      json(res, 200, { ok: true, autoSpeakArmed: true });
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

    if (req.method === "POST" && url.pathname === "/stt/listen") {
      if (speechBusy) {
        json(res, 409, { ok: false, error: "speech pipeline busy" });
        return;
      }
      const body = (await readJson(req)) as Record<string, unknown>;
      const seconds = typeof body.seconds === "number" ? body.seconds : 7;
      speechBusy = true;
      setState("listening", `recording ~${seconds}s`);
      try {
        const result = await listenOnce({ seconds });
        setState("transcribing", result.engine);
        pushEvent({
          type: "utterance",
          text: result.text,
          receivedAt: new Date().toISOString(),
        });
        setState(result.text ? "idle" : "error", result.text ? "stt ok" : "empty transcript");
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        setState("error", error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        speechBusy = false;
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/stt/status") {
      json(res, 200, { ok: true, ...getMicSessionStatus(), speechBusy });
      return;
    }

    if (req.method === "POST" && url.pathname === "/stt/start") {
      if (speechBusy) {
        json(res, 409, { ok: false, error: "speech pipeline busy" });
        return;
      }
      const body = (await readJson(req)) as Record<string, unknown>;
      const maxSeconds = typeof body.maxSeconds === "number" ? body.maxSeconds : 120;
      speechBusy = true;
      try {
        const started = await startMicSession({ maxSeconds });
        setState("listening", `push-to-talk ${started.id}`);
        json(res, 200, { ok: true, ...started });
      } catch (error) {
        speechBusy = false;
        setState("error", error instanceof Error ? error.message : String(error));
        throw error;
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/stt/stop") {
      console.log("[voice-cursor] POST /stt/stop");
      setState("transcribing", "stopping mic");
      try {
        const result = await stopMicSessionAndTranscribe();
        console.log(
          `[voice-cursor] /stt/stop ok durationMs=${result.durationMs} chars=${result.text.length}`,
        );
        pushEvent({
          type: "utterance",
          text: result.text,
          receivedAt: new Date().toISOString(),
        });
        setState(result.text ? "idle" : "error", result.text ? "stt ok" : "empty transcript");
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[voice-cursor] /stt/stop failed", message);
        setState("error", message);
        throw error;
      } finally {
        speechBusy = false;
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/stt/cancel") {
      await cancelMicSession();
      speechBusy = false;
      setState("idle", "listening cancelled");
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/tts/speak") {
      if (speechBusy || speakQueue.length > 0) {
        json(res, 409, { ok: false, error: "speech pipeline busy" });
        return;
      }
      const body = (await readJson(req)) as Record<string, unknown>;
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        json(res, 400, { ok: false, error: "text required" });
        return;
      }
      // Manual speak disarms auto-speak to avoid double playback.
      autoSpeakArmed = false;
      speechBusy = true;
      setState("speaking", text.slice(0, 80));
      try {
        const result = await speakText(text);
        pushEvent({
          type: "tts_done",
          ok: true,
          engine: result.engine,
          voice: result.voice,
          firstAudioMs: result.firstAudioMs,
          totalMs: result.totalMs,
          source: "tts/speak",
          at: new Date().toISOString(),
        });
        setState("idle", "spoke");
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushEvent({
          type: "tts_done",
          ok: false,
          error: message,
          source: "tts/speak",
          at: new Date().toISOString(),
        });
        setState("error", message);
        throw error;
      } finally {
        speechBusy = false;
        if (speakQueue.length) void drainSpeakQueue();
      }
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
  const stt = describeSttConfig();
  const tts = describeTtsConfig();
  console.log(`[voice-cursor] listening on http://${HOST}:${PORT}`);
  console.log(`[voice-cursor] websocket ws://${HOST}:${PORT}/ws`);
  console.log(
    `[voice-cursor] STT engine=${stt.engine} resolved=${stt.resolved} deepgram=${stt.hasDeepgram} openai=${stt.hasOpenAI}`,
  );
  console.log(
    `[voice-cursor] TTS engine=${tts.engine} resolved=${tts.resolved} voice=${tts.voice} rate=${tts.rate} stream=${tts.stream} deepgram=${tts.hasDeepgram}`,
  );
  logAuthHints();
  void warmTts();
});
