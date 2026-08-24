/**
 * panelAssetRetry — survive a transient pipe failure while loading a panel.
 *
 * A panel is a web page: its subresources are fetched by the webview, and a
 * single rejected `import()` is not a slow load, it is a dead panel behind an
 * error boundary until someone taps Reload. Every asset therefore has to be at
 * least as durable as the link underneath it, and on mobile that link drops
 * routinely — a Wi-Fi/cellular handover, an ICE restart, a keepalive timeout.
 * Measured across a day of device runs, every one of those blips turned into a
 * "Failed to fetch dynamically imported module" crash, because the façade
 * translated the first failure straight into a 502.
 *
 * The native bundle path already treats transfers as retryable
 * (`bundleTransferRetry`); panel assets simply never got the same treatment.
 *
 * Two rules keep this honest:
 *
 *  - **Only before the response is committed.** Once a status line has gone to
 *    the socket the webview owns a half-written response; re-running the fetch
 *    would concatenate a second body onto the first. `canRetry` is what the
 *    caller uses to say "nothing has been written yet".
 *  - **Wait for the pipe, not for a clock.** A retry is pointless while the
 *    transport is down and immediate once it is back, so the delay between
 *    attempts is the reconnect itself. A fixed backoff would be both too slow
 *    (idling after the pipe returned) and too fast (burning attempts while it
 *    is still gone).
 */

export type PipeStatus = "connected" | "connecting" | "disconnected" | string;

export interface RetryTransport {
  readonly status: PipeStatus;
  onStatusChange(callback: (status: PipeStatus) => void): () => void;
}

export interface PanelAssetRetryOptions {
  /** Optional diagnostic cap. Production requests retry while their client is alive. */
  attempts?: number;
  /** True while no byte of a response has reached the socket. */
  canRetry: () => boolean;
  /** Reports each retried failure so a flapping link is visible, not silent. */
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Transient = the pipe, not the resource. A 404 must never be retried. */
export function isTransientPipeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "PIPE_CLOSED" || code === "STREAM_RECEIVE_OVERFLOW") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /not connected/i.test(message) ||
    /pipe (is )?(down|closed)/i.test(message) ||
    /control channel closed/i.test(message) ||
    /HEAD not received/i.test(message) ||
    /bulk sequence gap/i.test(message) ||
    /ICE (failed|closed)/i.test(message)
  );
}

/**
 * Resolve once the transport reports `connected`, or immediately if it already
 * does. Resolves (rather than rejecting) on give-up so the caller's own attempt
 * budget stays the single place that decides when to stop.
 */
export function awaitPipeReady(transport: RetryTransport): Promise<void> {
  if (transport.status === "connected") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const off = transport.onStatusChange((status) => {
      if (status !== "connected") return;
      off();
      resolve();
    });
  });
}

/**
 * Run `attempt`, retrying transient pipe failures once the pipe is back.
 *
 * Rethrows when an explicit diagnostic budget is spent, the failure is not
 * transient, or the response is already committed. Production callers leave
 * the budget open: a WebView module request must survive however many failed
 * connection generations precede recovery, and `canRetry` ties its lifetime to
 * the requesting socket.
 */
export async function withPanelAssetRetry<T>(
  transport: RetryTransport,
  options: PanelAssetRetryOptions,
  attempt: () => Promise<T>
): Promise<T> {
  const budget = options.attempts === undefined ? null : Math.max(1, options.attempts);
  let lastError: unknown;
  for (let tries = 1; budget === null || tries <= budget; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const retryable =
        (budget === null || tries < budget) &&
        isTransientPipeError(error) &&
        options.canRetry();
      if (!retryable) break;
      options.onRetry?.(tries, error);
      await awaitPipeReady(transport);
    }
  }
  throw lastError;
}
