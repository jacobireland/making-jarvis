import type { AgentResponseEvent } from "@voice-cursor/shared";

type Waiter = {
  sinceMs: number;
  resolve: (event: AgentResponseEvent) => void;
};

const waiters = new Set<Waiter>();

/**
 * Called from the WS event handler when an agent_response arrives.
 * Resolves any PTT/one-shot waiters immediately (no HTTP poll lag).
 */
export function notifyAgentResponse(event: AgentResponseEvent): void {
  const at = event.receivedAt ? Date.parse(event.receivedAt) : Date.now();
  const text = (event.text ?? "").trim();
  if (text === "completed" || text === "aborted" || text === "error") return;

  for (const waiter of [...waiters]) {
    if (at >= waiter.sinceMs) {
      waiters.delete(waiter);
      waiter.resolve(event);
    }
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
      waiters.delete(waiter);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const waiter: Waiter = {
      sinceMs,
      resolve: (event) => {
        finish({
          ok: true,
          text: event.text,
          spokenText: event.spokenText ?? event.text,
        });
      },
    };
    waiters.add(waiter);

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
