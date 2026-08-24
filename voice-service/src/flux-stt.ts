import { WebSocket } from "ws";

export const FLUX_STT_SAMPLE_RATE = 16_000;
export const FLUX_STT_CHANNELS = 1;
export const FLUX_STT_BITS = 16;
/** 80ms of 16kHz mono 16-bit PCM — Deepgram's recommended Flux chunk. */
export const FLUX_STT_CHUNK_BYTES = 2560;
export const DEFAULT_FLUX_STT_MODEL = "flux-general-en";
export const DEFAULT_EOT_THRESHOLD = 0.7;
export const DEFAULT_EOT_TIMEOUT_MS = 7000;
export const MIN_COMMIT_CHARS = 2;
/** Sent while capture is parked so Deepgram does not idle-close the listen socket. */
export const FLUX_KEEPALIVE = { type: "KeepAlive" } as const;

export type FluxTurnEventName =
  | "Update"
  | "StartOfTurn"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn";

export type FluxTurnInfo = {
  type?: string;
  event?: string;
  transcript?: string;
  end_of_turn_confidence?: number;
  turn_index?: number;
  sequence_id?: number;
};

export function fluxListenUrl(options?: {
  model?: string;
  sampleRate?: number;
  eotThreshold?: number;
  eotTimeoutMs?: number;
}): string {
  const params = new URLSearchParams({
    model: options?.model ?? DEFAULT_FLUX_STT_MODEL,
    encoding: "linear16",
    sample_rate: String(options?.sampleRate ?? FLUX_STT_SAMPLE_RATE),
    eot_threshold: String(options?.eotThreshold ?? DEFAULT_EOT_THRESHOLD),
    eot_timeout_ms: String(options?.eotTimeoutMs ?? DEFAULT_EOT_TIMEOUT_MS),
  });
  return `wss://api.deepgram.com/v2/listen?${params}`;
}

export function parseFluxListenMessage(raw: string): FluxTurnInfo | null {
  try {
    return JSON.parse(raw) as FluxTurnInfo;
  } catch {
    return null;
  }
}

/** Commit only on high-confidence EndOfTurn with real transcript. */
export function shouldCommitFluxTurn(
  msg: FluxTurnInfo,
  options?: { minChars?: number },
): boolean {
  if ((msg.event ?? "") !== "EndOfTurn") return false;
  const text = (msg.transcript ?? "").replace(/\s+/g, " ").trim();
  const min = options?.minChars ?? MIN_COMMIT_CHARS;
  return text.length >= min;
}

export type FluxSttHandlers = {
  onTurn: (msg: FluxTurnInfo) => void;
  onError?: (error: Error) => void;
};

/**
 * One-shot Deepgram Flux STT session (`wss://…/v2/listen`).
 * Send raw linear16 PCM; listen for TurnInfo EndOfTurn.
 */
export class FluxSttSession {
  private socket: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly handlers: FluxSttHandlers;
  private connectPromise: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: {
    apiKey: string;
    model?: string;
    eotThreshold?: number;
    eotTimeoutMs?: number;
    handlers: FluxSttHandlers;
  }) {
    this.apiKey = options.apiKey;
    this.url = fluxListenUrl({
      model: options.model,
      eotThreshold: options.eotThreshold,
      eotTimeoutMs: options.eotTimeoutMs,
    });
    this.handlers = options.handlers;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Flux STT session is closed");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  sendPcm(pcm: Buffer): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closed) return;
    if (pcm.length === 0) return;
    try {
      ws.send(pcm);
    } catch (error) {
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  sendKeepAlive(): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closed) return;
    try {
      ws.send(JSON.stringify(FLUX_KEEPALIVE));
    } catch (error) {
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  get connected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && !this.closed);
  }

  /**
   * Re-open after an unexpected socket drop. Explicit {@link close} still
   * permanently ends the session.
   */
  async reconnect(): Promise<void> {
    if (this.closed) throw new Error("Flux STT session is closed");
    this.stopPing();
    const ws = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    await this.connect();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopPing();
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 400);
      try {
        ws.once("close", () => {
          clearTimeout(t);
          resolve();
        });
        ws.close();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      ws.binaryType = "nodebuffer";

      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        fail(new Error("Flux STT WebSocket connect timeout"));
      }, 12_000);

      ws.on("open", () => {
        // Wait for Connected before sending audio.
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const text =
          typeof data === "string"
            ? data
            : Buffer.from(data as ArrayBuffer).toString("utf8");
        const msg = parseFluxListenMessage(text);
        if (!msg) {
          console.warn(`[voice-cursor] flux-stt non-json: ${text.slice(0, 120)}`);
          return;
        }
        const type = msg.type ?? "";
        if (!settled) {
          if (type === "Connected") {
            this.socket = ws;
            this.startPing();
            console.log(`[voice-cursor] flux-stt connected url=${this.url}`);
            ok();
            return;
          }
          if (type === "FatalError" || type === "Error") {
            fail(new Error(`Flux STT handshake ${type}: ${text.slice(0, 240)}`));
            return;
          }
          return;
        }
        if (type === "TurnInfo") {
          this.handlers.onTurn(msg);
          return;
        }
        if (type === "FatalError" || type === "Error") {
          this.handlers.onError?.(new Error(`Flux STT ${type}: ${text.slice(0, 240)}`));
        }
      });

      ws.on("error", (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!settled) fail(err);
        else this.handlers.onError?.(err);
      });

      ws.on("close", (code, reason) => {
        const why = reason?.toString?.() || "";
        console.warn(`[voice-cursor] flux-stt socket closed code=${code} reason=${why}`);
        this.stopPing();
        if (this.socket === ws) this.socket = null;
        const err = new Error(`Flux STT socket closed (${code}) ${why}`.trim());
        if (!settled) fail(err);
        else if (!this.closed) this.handlers.onError?.(err);
      });
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }, 20_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export function resolveEotThreshold(): number {
  const raw = Number(process.env.VOICE_CURSOR_EOT_THRESHOLD ?? DEFAULT_EOT_THRESHOLD);
  if (!Number.isFinite(raw)) return DEFAULT_EOT_THRESHOLD;
  return Math.min(0.9, Math.max(0.5, raw));
}

export function resolveEotTimeoutMs(): number {
  const raw = Number(process.env.VOICE_CURSOR_EOT_TIMEOUT_MS ?? DEFAULT_EOT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_EOT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(500, Math.round(raw)));
}
