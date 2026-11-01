// A background loop that never overlaps itself: a tick that takes longer than the interval (slow sandbox calls,
// a big workspace to upload) makes the next one wait instead of running alongside it. Overlapping ticks would see
// the same row in the same state and act twice, for example starting a second agent in the same sandbox.
export function serialLoop(tick: () => Promise<unknown>, intervalMs: number, label: string): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((e) => console.error(label, e))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}
