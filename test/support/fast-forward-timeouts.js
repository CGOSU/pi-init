import { setImmediate } from "node:timers/promises";

// Let real asynchronous I/O reach each retry before advancing only its timers.
// Advancing once by the whole timeout would miss timers scheduled after fs settles.
export async function fastForwardTimeouts(t, run) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setMockTimeout = globalThis.setTimeout;
  const delays = [];
  let wake, advanced = 0, settled = false;
  // Keep this observer outside MockTracker: its automatic cleanup would otherwise
  // restore the already-reset fake timer over the real timer for following tests.
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = setMockTimeout(callback, delay, ...args);
    delays.push(delay);
    wake?.();
    return timer;
  };
  const operation = Promise.resolve().then(run);
  const finish = () => { settled = true; wake?.(); };
  void operation.then(finish, finish);
  try {
    while (!settled) {
      if (delays.length === advanced) await new Promise(resolve => { wake = resolve; });
      wake = undefined;
      if (settled) break;
      await setImmediate();
      advanced = delays.length;
      t.mock.timers.runAll();
    }
    await operation;
    return delays;
  } finally {
    globalThis.setTimeout = setMockTimeout;
    t.mock.timers.reset();
  }
}
