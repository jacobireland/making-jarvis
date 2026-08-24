import * as vscode from "vscode";

type ListenEnd = "send" | "cancel";

let endListen: ((action: ListenEnd) => void) | null = null;

/** Resolve the sticky listening UI (status-bar stop or progress cancel). */
export function signalListenEnd(action: ListenEnd): void {
  const resolve = endListen;
  endListen = null;
  resolve?.(action);
}

/**
 * Sticky listening UI that does not auto-dismiss like a toast.
 * - Notification progress stays until Stop & Send or Cancel
 * - Caller should also set the status bar to the stop command
 */
export async function showStickyListeningUi(options?: {
  onCancel?: () => Promise<void> | void;
  message?: string;
}): Promise<ListenEnd> {
  if (endListen) {
    // Previous UI still open — end it as cancel so we don't leak waiters.
    signalListenEnd("cancel");
  }

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Voice Cursor: listening…",
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({
        message:
          options?.message ??
          "Click the status-bar mic (“listening — click to send”) when done",
      });

      return await new Promise<ListenEnd>((resolve) => {
        endListen = resolve;

        token.onCancellationRequested(() => {
          void Promise.resolve(options?.onCancel?.()).finally(() => {
            signalListenEnd("cancel");
          });
        });
      });
    },
  );
}
