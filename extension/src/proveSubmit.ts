export type ServiceEvent = {
  type: string;
  text?: string;
  spokenText?: string;
  receivedAt?: string;
};

export type ProveResult = {
  ok: boolean;
  marker: string;
  injectSubmitted: boolean;
  submitMethod?: string;
  capturedText?: string;
  detail: string;
};

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
