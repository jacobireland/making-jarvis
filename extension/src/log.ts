/** Prefix log lines with local time + optional elapsed ms from a turn start. */
export function createTimedLogger(
  write: (message: string) => void,
  options?: { startedAt?: number },
): (message: string) => void {
  const startedAt = options?.startedAt ?? Date.now();
  return (message: string) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    const elapsed = Date.now() - startedAt;
    write(`[${hh}:${mm}:${ss}.${ms} +${elapsed}ms] ${message}`);
  };
}
