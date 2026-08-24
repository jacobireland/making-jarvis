/** Whether to start listening again after a talk turn finishes. */
export function shouldAutoRearm(input: {
  sessionEnabled: boolean;
  autoRearm: boolean;
  cancelled: boolean;
}): boolean {
  return input.sessionEnabled && input.autoRearm && !input.cancelled;
}
