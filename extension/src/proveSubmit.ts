export type ServiceEvent = {
  type: string;
  text?: string;
  spokenText?: string;
  receivedAt?: string;
};

/**
 * Poll until an agent_response newer than `sinceIso` appears.
 */
export async function waitForNextAgentResponse(
  serviceBase: string,
  options: { timeoutMs?: number; pollMs?: number; sinceIso: string },
): Promise<{ ok: boolean; text?: string; spokenText?: string }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 1000;
  const since = Date.parse(options.sinceIso);
  const deadline = Date.now() + timeoutMs;
  const base = serviceBase.replace(/\/$/, "");

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/events?limit=40`);
      const body = (await res.json()) as { events?: ServiceEvent[] };
      const events = body.events ?? [];
      for (const event of [...events].reverse()) {
        if (event.type !== "agent_response" || typeof event.text !== "string") continue;
        // Ignore stop-hook false positives if any old ones linger.
        if (event.text === "completed" || event.text === "aborted" || event.text === "error") {
          continue;
        }
        const at = event.receivedAt ? Date.parse(event.receivedAt) : 0;
        if (at && at >= since) {
          return {
            ok: true,
            text: event.text,
            spokenText: event.spokenText ?? event.text,
          };
        }
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false };
}

/**
 * Poll the local voice service until an agent_response containing `marker` appears.
 */
export async function waitForCapturedMarker(
  serviceBase: string,
  marker: string,
  options: { timeoutMs?: number; pollMs?: number; sinceIso?: string } = {},
): Promise<{ ok: boolean; text?: string }> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 1000;
  const since = options.sinceIso ? Date.parse(options.sinceIso) : Date.now() - 1000;
  const deadline = Date.now() + timeoutMs;
  const base = serviceBase.replace(/\/$/, "");

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/events?limit=30`);
      const body = (await res.json()) as { events?: ServiceEvent[] };
      const events = body.events ?? [];
      for (const event of [...events].reverse()) {
        if (event.type !== "agent_response" || typeof event.text !== "string") continue;
        const at = event.receivedAt ? Date.parse(event.receivedAt) : 0;
        if (at && at < since) continue;
        if (event.text.includes(marker) || (event.spokenText ?? "").includes(marker)) {
          return { ok: true, text: event.text };
        }
      }
    } catch {
      // service may briefly restart
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false };
}
