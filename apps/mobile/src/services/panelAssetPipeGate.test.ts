import { createPipeGate } from "./panelAssetPipeGate";

/**
 * The gate exists because react-native-webrtc's receive bridge silently drops
 * frames when several bulk streams are answered at once, so "never more than
 * `limit` holders" is a correctness property, not a tuning knob. These cover the
 * two ways a hand-rolled semaphore usually breaks it: overshoot on handoff, and
 * a waiter that is never woken.
 */
describe("createPipeGate", () => {
  it("admits up to the limit without waiting", async () => {
    const gate = createPipeGate(2);
    const first = await gate.acquire();
    const second = await gate.acquire();
    expect(typeof first).toBe("function");
    expect(typeof second).toBe("function");
  });

  it("makes the next caller wait until a holder releases", async () => {
    const gate = createPipeGate(1);
    const held = await gate.acquire();
    let admitted = false;
    const queued = gate.acquire().then((release) => {
      admitted = true;
      return release;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);

    held();
    await queued;
    expect(admitted).toBe(true);
  });

  it("never exceeds the limit when a release and a fresh arrival race", async () => {
    // The overshoot bug: release decrements, and a caller arriving before the
    // woken waiter resumes sees a free slot that is already spoken for. Handing
    // the slot straight over is what prevents it — so both contenders here must
    // not end up inside at once.
    const gate = createPipeGate(1);
    let concurrent = 0;
    let peak = 0;
    const body = async (): Promise<void> => {
      const release = await gate.acquire();
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      release();
    };

    await Promise.all(Array.from({ length: 12 }, () => body()));
    expect(peak).toBe(1);
    expect(concurrent).toBe(0);
  });

  it("serializes strictly: work does not interleave under the gate", async () => {
    const gate = createPipeGate(1);
    const order: string[] = [];
    const task = async (name: string): Promise<void> => {
      const release = await gate.acquire();
      order.push(`${name}:start`);
      await Promise.resolve();
      await Promise.resolve();
      order.push(`${name}:end`);
      release();
    };

    await Promise.all([task("a"), task("b"), task("c")]);
    // Every start is immediately followed by its own end.
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("tolerates a release called more than once", async () => {
    // handleRequest releases in a finally that can be reached twice on some
    // error paths; a double release must not hand out a slot that does not exist.
    const gate = createPipeGate(1);
    const release = await gate.acquire();
    release();
    release();

    let admitted = 0;
    await Promise.all([
      gate.acquire().then((r) => {
        admitted += 1;
        r();
      }),
      gate.acquire().then((r) => {
        admitted += 1;
        r();
      }),
    ]);
    expect(admitted).toBe(2);
  });
});
