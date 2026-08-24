type ListenEnd = "send" | "cancel";

let endListen: ((action: ListenEnd) => void) | null = null;

/** Resolve a listen waiter if one exists (status-bar send/cancel). No-op otherwise. */
export function signalListenEnd(action: ListenEnd): void {
  const resolve = endListen;
  endListen = null;
  resolve?.(action);
}
