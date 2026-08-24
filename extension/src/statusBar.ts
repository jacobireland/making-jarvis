/** Status-bar copy is only IDLE or LISTENING — no toasts for listen state. */

export function voiceCursorStatusBarText(listening: boolean): string {
  return listening
    ? "$(mic) Voice Cursor: LISTENING"
    : "$(unmute) Voice Cursor: IDLE";
}

export function voiceCursorStatusBarTooltip(
  listening: boolean,
  sessionOn: boolean,
): string {
  if (listening) return "Click to turn off, or send now";
  if (sessionOn) return "Click to turn Voice Cursor off";
  return "Click to turn listening on";
}
