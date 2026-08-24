import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const FLUX_SAMPLE_RATE = 24_000;
const FLUX_CHANNELS = 1;
const FLUX_BITS = 16;

export type FluxAudioHandler = (pcm: Buffer) => void;

export type FluxSpeakTurnResult = {
  speechId?: string;
  audioBytes: number;
  firstByteMs?: number;
  metadataMs?: number;
};

type PendingTurn = {
  onAudio: FluxAudioHandler;
  settle: (value: FluxSpeakTurnResult) => void;
  fail: (error: Error) => void;
  startedAt: number;
  firstByteMs?: number;
  audioBytes: number;
  speechId?: string;
  gotMetadata: boolean;
};

/**
 * Persistent Deepgram Flux TTS (`wss://…/v2/speak`) session.
 * Speaks one turn at a time; binary linear16 frames stream as they arrive.
 */
export class FluxTtsSession {
  private socket: WebSocket | null = null;
  private readonly model: string;
  private readonly speed: number;
  private readonly apiKey: string;
  private connectPromise: Promise<void> | null = null;
  private pending: PendingTurn | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: { apiKey: string; model: string; speed: number }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.speed = options.speed;
  }

  get configKey(): string {
    return `${this.model}|${this.speed}`;
  }

  async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error("Flux TTS session is closed");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: this.model,
        encoding: "linear16",
        sample_rate: String(FLUX_SAMPLE_RATE),
      });
      const url = `wss://api.deepgram.com/v2/speak?${params}`;
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      // Prefer Buffer frames over Blob in Node.
      ws.binaryType = "nodebuffer";

      let settled = false;
      let configureFallback: ReturnType<typeof setTimeout> | null = null;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (configureFallback) {
          clearTimeout(configureFallback);
          configureFallback = null;
        }
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
        fail(new Error("Flux TTS WebSocket connect timeout"));
      }, 12_000);

      ws.on("open", () => {
        // Wait for Connected (or ConfigureSuccess after we send Configure).
      });

      const markReady = (via: string) => {
        if (settled) return;
        if (configureFallback) {
          clearTimeout(configureFallback);
          configureFallback = null;
        }
        this.socket = ws;
        this.startPing();
        console.log(
          `[voice-cursor] flux-tts connected model=${this.model} speed=${this.speed} via=${via}`,
        );
        ok();
      };

      ws.on("message", (data, isBinary) => {
        // Text control frames arrive as Buffer with isBinary=false — do not treat as PCM.
        if (isBinary) {
          const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          if (buf.length === 0) return;
          if (!settled) return;
          this.handleAudio(buf);
          return;
        }

        const text =
          typeof data === "string"
            ? data
            : Buffer.from(data as ArrayBuffer).toString("utf8");
        let msg: { type?: string; description?: string; message?: string; speech_id?: string };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          console.warn(`[voice-cursor] flux-tts non-json: ${text.slice(0, 120)}`);
          return;
        }

        if (!settled) {
          if (msg.type === "Connected") {
            try {
              ws.send(JSON.stringify({ type: "Configure", speed: this.speed }));
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            // Prefer ConfigureSuccess; fall back if the server stays quiet.
            configureFallback = setTimeout(() => markReady("connected-timeout"), 400);
            return;
          }
          if (msg.type === "ConfigureSuccess") {
            markReady("configure-success");
            return;
          }
          if (msg.type === "Error" || msg.type === "ConfigureFailure") {
            if (configureFallback) {
              clearTimeout(configureFallback);
              configureFallback = null;
            }
            fail(
              new Error(
                `Flux TTS handshake ${msg.type}: ${msg.description || msg.message || text.slice(0, 200)}`,
              ),
            );
            return;
          }
          return;
        }

        this.handleControl(msg, text);
      });

      ws.on("error", (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!settled) fail(err);
        else this.failPending(err);
      });

      ws.on("close", (code, reason) => {
        const why = reason?.toString?.() || "";
        console.warn(`[voice-cursor] flux-tts socket closed code=${code} reason=${why}`);
        this.stopPing();
        if (this.socket === ws) this.socket = null;
        const err = new Error(`Flux TTS socket closed (${code}) ${why}`.trim());
        if (!settled) fail(err);
        else this.failPending(err);
      });
    });
  }

  private startPing(): void {
    this.stopPing();
    // Idle sessions drop after ~60s without inbound traffic — ping to keep warm.
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

  private handleAudio(buf: Buffer): void {
    const turn = this.pending;
    if (!turn || turn.gotMetadata) return;
    if (turn.firstByteMs === undefined) {
      turn.firstByteMs = Date.now() - turn.startedAt;
      console.log(`[voice-cursor] flux-tts firstByteMs=${turn.firstByteMs}`);
    }
    turn.audioBytes += buf.length;
    turn.onAudio(buf);
  }

  private handleControl(
    msg: { type?: string; description?: string; message?: string; speech_id?: string },
    raw: string,
  ): void {
    const type = msg.type ?? "";
    if (type === "Warning") {
      console.warn(`[voice-cursor] flux-tts warning: ${raw.slice(0, 240)}`);
      return;
    }
    if (type === "Error") {
      this.failPending(
        new Error(`Flux TTS error: ${msg.description || msg.message || raw.slice(0, 200)}`),
      );
      return;
    }
    const turn = this.pending;
    if (!turn) return;
    if (type === "SpeechStarted" && msg.speech_id) {
      turn.speechId = msg.speech_id;
      return;
    }
    if (type === "SpeechMetadata") {
      turn.gotMetadata = true;
      const result: FluxSpeakTurnResult = {
        speechId: turn.speechId ?? msg.speech_id,
        audioBytes: turn.audioBytes,
        firstByteMs: turn.firstByteMs,
        metadataMs: Date.now() - turn.startedAt,
      };
      this.pending = null;
      turn.settle(result);
      return;
    }
    // Flushed / SpeechInterrupted / etc. — wait for SpeechMetadata for end-of-turn.
  }

  private failPending(error: Error): void {
    const turn = this.pending;
    if (!turn) return;
    this.pending = null;
    turn.fail(error);
  }

  /**
   * Synthesize one agent turn. Audio callbacks fire as PCM arrives (before turn ends).
   */
  async speakTurn(text: string, onAudio: FluxAudioHandler): Promise<FluxSpeakTurnResult> {
    // Preserve punctuation boundaries from toSpokenText; only collapse raw whitespace.
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return { audioBytes: 0 };
    }
    if (this.pending) {
      throw new Error("Flux TTS turn already in progress");
    }

    await this.ensureConnected();
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Flux TTS socket not open");
    }

    return await new Promise<FluxSpeakTurnResult>((resolve, reject) => {
      const turn: PendingTurn = {
        onAudio,
        settle: resolve,
        fail: reject,
        startedAt: Date.now(),
        audioBytes: 0,
        gotMetadata: false,
      };
      this.pending = turn;

      const timeout = setTimeout(() => {
        if (this.pending === turn) {
          this.pending = null;
          reject(new Error("Flux TTS turn timed out waiting for SpeechMetadata"));
        }
      }, Math.max(45_000, cleaned.length * 40));

      const settle = turn.settle;
      const fail = turn.fail;
      turn.settle = (value) => {
        clearTimeout(timeout);
        settle(value);
      };
      turn.fail = (error) => {
        clearTimeout(timeout);
        fail(error);
      };

      try {
        // One Speak for the full reply (already known); Flush ends the turn.
        ws.send(JSON.stringify({ type: "Speak", text: cleaned }));
        ws.send(JSON.stringify({ type: "Flush" }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopPing();
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "Close" }));
      }
    } catch {
      // ignore
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

export function pcmToWav(
  pcm: Buffer,
  options?: { sampleRate?: number; channels?: number; bitsPerSample?: number },
): Buffer {
  const sampleRate = options?.sampleRate ?? FLUX_SAMPLE_RATE;
  const channels = options?.channels ?? FLUX_CHANNELS;
  const bitsPerSample = options?.bitsPerSample ?? FLUX_BITS;
  // 16-bit samples must be even length.
  const data = pcm.length % 2 === 1 ? pcm.subarray(0, pcm.length - 1) : pcm;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function writePcmWavFile(filePath: string, pcm: Buffer): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, pcmToWav(pcm));
  return filePath;
}

export const FLUX_TTS_SAMPLE_RATE = FLUX_SAMPLE_RATE;
