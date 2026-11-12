import { describe, expect, it } from "vitest";
import { DailyLimiter } from "../lib/usage";

describe("DailyLimiter", () => {
  it("allows up to the limit per user per UTC day, then refuses until the next day", () => {
    let t = Date.parse("2026-10-31T10:00:00Z");
    const limiter = new DailyLimiter(2, () => t);
    expect(limiter.take("u1")).toBe(true);
    expect(limiter.take("u1")).toBe(true);
    expect(limiter.take("u1")).toBe(false);
    expect(limiter.remaining("u1")).toBe(0);
    expect(limiter.take("u2")).toBe(true);
    t = Date.parse("2026-11-01T00:00:01Z");
    expect(limiter.take("u1")).toBe(true);
    expect(limiter.remaining("u1")).toBe(1);
  });

  it("treats 0 as no limit", () => {
    const limiter = new DailyLimiter(0);
    for (let i = 0; i < 1000; i++) expect(limiter.take("u1")).toBe(true);
    expect(limiter.remaining("u1")).toBe(Infinity);
  });
});
