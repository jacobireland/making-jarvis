import type { AgentResponseEvent, TtsDoneEvent } from "@voice-cursor/shared";

type AgentWaiter = {
  sinceMs: number;
  resolve: (event: AgentResponseEvent) => void;
};

type TtsWaiter = {
  sinceMs: number;
  /** If set, only tts_done events whose source is in this list will settle the wait. */
  sources?: string[];
  resolve: (event: TtsDoneEvent) => void;
};

const agentWaiters = new Set<AgentWaiter>();
const ttsWaiters = new Set<TtsWaiter>();

/** Final reply / manual speak — not thinking-block TTS. */
export const FINAL_TTS_SOURCES = ["after-agent-response", "tts/speak"] as const;

function matchesTtsSource(event: TtsDoneEvent, sources?: string[]): boolean {
  if (!sources || sources.length === 0) return true;
  // Legacy events without source: treat as final (manual /tts/speak before source tagging).
  if (!event.source) return sources.includes("tts/speak");
  return sources.includes(event.source);
}

/**
 * Called from the WS event handler when an agent_response arrives.
 * Resolves any PTT/one-shot waiters immediately (no HTTP poll lag).
 */
export function notifyAgentResponse(event: AgentResponseEvent): void {
  const at = event.receivedAt ? Date.parse(event.receivedAt) : Date.now();
  const text = (event.text ?? "").trim();
  if (text === "completed" || text === "aborted" || text === "error") return;

  for (const waiter of [...agentWaiters]) {
    if (at >= waiter.sinceMs) {
      agentWaiters.delete(waiter);
      waiter.resolve(event);
    }
  }
}

export function notifyTtsDone(event: TtsDoneEvent): void {
  const at = event.at ? Date.parse(event.at) : Date.now();
  for (const waiter of [...ttsWaiters]) {
    if (at < waiter.sinceMs) continue;
    if (!matchesTtsSource(event, waiter.sources)) continue;
    ttsWaiters.delete(waiter);
    waiter.resolve(event);
  }
}

async function fetchLatestAgentResponse(
  serviceBase: string,
  sinceMs: number,
): Promise<AgentResponseEvent | null> {
  try {
    const res = await fetch(`${serviceBase.replace(/\/$/, "")}/events?limit=40`);
    const body = (await res.json()) as {
      events?: Array<{
        type: string;
        text?: string;
        spokenText?: string;
        receivedAt?: string;
      }>;
    };
    for (const event of [...(body.events ?? [])].reverse()) {
      if (event.type !== "agent_response" || typeof event.text !== "string") continue;
      if (event.text === "completed" || event.text === "aborted" || event.text === "error") {
        continue;
      }
      const at = event.receivedAt ? Date.parse(event.receivedAt) : 0;
      if (at && at >= sinceMs) {
        return event as AgentResponseEvent;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchLatestTtsDone(
  serviceBase: string,
  sinceMs: number,
  sources?: string[],
): Promise<TtsDoneEvent | null> {
  try {
    const res = await fetch(`${serviceBase.replace(/\/$/, "")}/events?limit=40`);
    const body = (await res.json()) as { events?: TtsDoneEvent[] };
    for (const event of [...(body.events ?? [])].reverse()) {
      if (event.type !== "tts_done") continue;
      const at = event.at ? Date.parse(event.at) : 0;
      if (!at || at < sinceMs) continue;
      if (!matchesTtsSource(event, sources)) continue;
      return event;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Wait for the next agent_response at/after sinceIso.
 * Uses WS notify + fast HTTP poll in parallel so speech starts ASAP.
 */
export async function waitForAgentResponseFast(
  serviceBase: string,
  options: { sinceIso: string; timeoutMs?: number },
): Promise<{ ok: boolean; text?: string; spokenText?: string }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const sinceMs = Date.parse(options.sinceIso);

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: {
      ok: boolean;
      text?: string;
      spokenText?: string;
    }) => {
      if (settled) return;
      settled = true;
      agentWaiters.delete(waiter);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const waiter: AgentWaiter = {
      sinceMs,
      resolve: (event) => {
        finish({
          ok: true,
          text: event.text,
          spokenText: event.spokenText ?? event.text,
        });
      },
    };
    agentWaiters.add(waiter);

    const checkHttp = async () => {
      const hit = await fetchLatestAgentResponse(serviceBase, sinceMs);
      if (hit) {
        finish({
          ok: true,
          text: hit.text,
          spokenText: hit.spokenText ?? hit.text,
        });
      }
    };

    void checkHttp();
    const pollTimer = setInterval(() => {
      void checkHttp();
    }, 120);

    const timeoutTimer = setTimeout(() => {
      finish({ ok: false });
    }, timeoutMs);
  });
}

/**
 * Wait for TTS to finish after sinceIso.
 * By default only final-reply sources settle (ignores after-agent-thought).
 */
export async function waitForTtsDoneFast(
  serviceBase: string,
  options: {
    sinceIso: string;
    timeoutMs?: number;
    /** Defaults to final reply / manual speak sources. */
    sources?: string[];
  },
): Promise<TtsDoneEvent | null> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const sinceMs = Date.parse(options.sinceIso);
  const sources = options.sources ?? [...FINAL_TTS_SOURCES];

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (event: TtsDoneEvent | null) => {
      if (settled) return;
      settled = true;
      ttsWaiters.delete(waiter);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve(event);
    };

    const waiter: TtsWaiter = {
      sinceMs,
      sources,
      resolve: (event) => finish(event),
    };
    ttsWaiters.add(waiter);

    const checkHttp = async () => {
      const hit = await fetchLatestTtsDone(serviceBase, sinceMs, sources);
      if (hit) finish(hit);
    };

    void checkHttp();
    const pollTimer = setInterval(() => {
      void checkHttp();
    }, 150);

    const timeoutTimer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
  });
}
