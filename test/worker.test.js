import { test } from "node:test";
import assert from "node:assert/strict";
import { serialLoop } from "../dist/worker.js";

test("a worker tick never overlaps the previous one, however slow it is", async () => {
  let running = 0;
  let maxRunning = 0;
  let ticks = 0;
  const timer = serialLoop(
    async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      ticks++;
      await new Promise((r) => setTimeout(r, 60)); // much longer than the interval
      running--;
    },
    5,
    "test worker",
  );
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(timer);
  assert.equal(maxRunning, 1, "never two ticks at once");
  assert.ok(ticks >= 3, `ticks keep coming after each one ends (${ticks})`);
});

test("a failing tick is logged and the loop carries on", async () => {
  let ticks = 0;
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const timer = serialLoop(
      async () => {
        ticks++;
        throw new Error("boom");
      },
      5,
      "test worker",
    );
    await new Promise((r) => setTimeout(r, 60));
    clearInterval(timer);
  } finally {
    console.error = original;
  }
  assert.ok(ticks >= 2);
  assert.match(errors[0], /test worker/);
});
