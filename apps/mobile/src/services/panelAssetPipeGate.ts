/**
 * panelAssetPipeGate — bounds how many panel-asset fetches occupy the WebRTC
 * pipe at once.
 *
 * A webview loading a panel fans out — module graphs and stylesheets go out in
 * parallel — and the façade turns each request into its own bulk stream the
 * instant it arrives. The gateway then answers them together, so their frames
 * leave interleaved and back-to-back, which is the one pattern
 * react-native-webrtc's receive bridge drops on the floor (see webrtcAnswerer's
 * MOBILE_BULK_LOW_WATER, which intends to prevent exactly this and cannot,
 * because it keys on the sender's own buffered amount).
 *
 * Measured on a device: six streams answered in the same instant (21 frames)
 * were lost whole — no error, no teardown, the pipe still up and serving — while
 * single streams of 126 KB and 133 KB over that same pipe seconds earlier
 * arrived intact. Size was never the trigger; simultaneity was.
 *
 * Lives apart from the façade so it can be tested without the native TCP module.
 */

export interface PipeGate {
  acquire: () => Promise<() => void>;
}

/**
 * Admits a bounded number of holders at once; every acquire resolves to a
 * release that is safe to call twice.
 *
 * A freed slot is handed straight to the next waiter rather than decremented and
 * re-taken. Decrementing first opens a window: a caller arriving between the
 * release and the woken waiter's resumption sees a free slot that is already
 * spoken for, and both run — which for this gate means the burst it exists to
 * prevent.
 */
export function createPipeGate(limit: number): PipeGate {
  let active = 0;
  const waiting: Array<() => void> = [];
  const releaseSlot = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  };
  return {
    async acquire(): Promise<() => void> {
      if (active < limit) active += 1;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
    },
  };
}
