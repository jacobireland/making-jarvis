/** Local wall-clock for Output-channel lines: `12:39:17.230` */
export function formatLogClock(now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Prefix every physical line with `[HH:MM:SS.mmm]`. */
export function stampLogMessage(message: string, now = new Date()): string[] {
  const clock = formatLogClock(now);
  const lines = String(message ?? "").split(/\r?\n/);
  return lines.map((line) => `[${clock}] ${line}`);
}

type LineWriter = { appendLine(value: string): void };

/**
 * Stamp every `appendLine` on a VS Code OutputChannel (including multiline dumps
 * and `[service:out]` forwards) so each visible line starts with a timestamp.
 */
export function stampOutputChannel<T extends LineWriter>(channel: T): T {
  const rawAppendLine = channel.appendLine.bind(channel);
  channel.appendLine = (value: string) => {
    const now = new Date();
    for (const line of stampLogMessage(String(value ?? ""), now)) {
      rawAppendLine(line);
    }
  };
  return channel;
}

/** Prefix log lines with elapsed ms from a turn start (clock comes from stampOutputChannel). */
export function createTimedLogger(
  write: (message: string) => void,
  options?: { startedAt?: number },
): (message: string) => void {
  const startedAt = options?.startedAt ?? Date.now();
  return (message: string) => {
    const elapsed = Date.now() - startedAt;
    write(`+${elapsed}ms ${message}`);
  };
}
