import { describe, expect, it } from "vitest";
import { budgetFrom, capChoice, clampCap } from "@/lib/build-cap";
import { buildStateFrom, canShip, startsNewBuild } from "@/lib/chat";
import { parseStudioCall } from "@/lib/studio-tools";
import { NewAppRequest } from "@/lib/new-app";

const reply = (budget: Record<string, unknown>) => ({ builds: [], budget: { default_cap_usd: 10, month_left_usd: 40, workspace_left_usd: null, min_cap_usd: 0.5, session_cap_above_usd: 2, ...budget } });

describe("the cap for a new build", () => {
  it("reads Mynt's budget from list_builds, and nothing where it doesn't report one", () => {
    expect(budgetFrom(reply({}))).toEqual({ defaultCapUsd: 10, monthLeftUsd: 40, workspaceLeftUsd: null, minCapUsd: 0.5, sessionCapAboveUsd: 2 });
    expect(budgetFrom({ builds: [] })).toBeNull();
    expect(budgetFrom(reply({ default_cap_usd: "10" }))).toBeNull();
  });

  it("starts at the usual cap, or at what's left this month when that's less (the workspace's too)", () => {
    expect(capChoice(budgetFrom(reply({}))!, { session: true })).toEqual({ maxUsd: 10, minUsd: 2.01, startUsd: 10, blocked: null });
    expect(capChoice(budgetFrom(reply({ month_left_usd: 6.257 }))!, { session: true })).toMatchObject({ maxUsd: 6.25, startUsd: 6.25, blocked: null });
    expect(capChoice(budgetFrom(reply({ workspace_left_usd: 3 }))!, { session: false })).toMatchObject({ maxUsd: 3, minUsd: 0.5, blocked: null });
  });

  it("blocks starting a build when too little is left, saying why", () => {
    expect(capChoice(budgetFrom(reply({ month_left_usd: 0.3 }))!, { session: false }).blocked).toBe(
      "Only US$0.30 of your build budget is left this month, and a build needs at least US$0.50. It renews at the start of next month.",
    );
    // A session build's cap must be above its shipping reserve.
    expect(capChoice(budgetFrom(reply({ month_left_usd: 1.5 }))!, { session: true }).blocked).toMatch(/^Only US\$1\.50 of your build budget is left this month, and a build here needs a cap above US\$2\.00/);
    expect(capChoice(budgetFrom(reply({ month_left_usd: 1.5 }))!, { session: false }).blocked).toBeNull();
    expect(capChoice(budgetFrom(reply({ workspace_left_usd: 0.2 }))!, { session: false }).blocked).toMatch(/of the workspace's build budget/);
  });

  it("holds a typed cap to what's allowed, to the cent", () => {
    const choice = capChoice(budgetFrom(reply({ month_left_usd: 6 }))!, { session: true });
    expect(clampCap("4.567", choice)).toBe(4.56);
    expect(clampCap("100", choice)).toBe(6);
    expect(clampCap("1", choice)).toBe(2.01);
    expect(clampCap("abc", choice)).toBeNull();
  });

  it("is sent only within the studio's strict limits", () => {
    const base = { goal: "A savings screen with a goal tracker", app_id: "a1" };
    expect(parseStudioCall("start_build", { ...base, cap_usd: 7.5 })).toEqual({ tool: "start_build", args: { ...base, cap_usd: 7.5 } });
    expect(parseStudioCall("start_build", { ...base, cap_usd: 7.555 })).toHaveProperty("error");
    expect(parseStudioCall("start_build", { ...base, cap_usd: 0 })).toHaveProperty("error");
    expect(NewAppRequest.safeParse({ prompt: "A savings screen with a goal tracker", product_ids: ["p1"], cap_usd: 4 }).success).toBe(true);
    expect(NewAppRequest.safeParse({ prompt: "A savings screen with a goal tracker", product_ids: ["p1"], cap_usd: -4 }).success).toBe(false);
  });
});

describe("what the builder's composer offers", () => {
  it("Ship while a session's agent is open and not already shipping; a cap once nothing is running", () => {
    const s = buildStateFrom({ id: "b", status: "coding", mode: "session" });
    expect(s).toEqual({ buildId: "b", status: "coding", session: true, finishing: false });
    expect(canShip(s)).toBe(true);
    expect(startsNewBuild(s)).toBe(false);
    expect(canShip(buildStateFrom({ id: "b", status: "coding", mode: "session", finish_requested_at: "2026-11-22T10:00:00Z" }))).toBe(false);
    expect(canShip(buildStateFrom({ id: "b", status: "coding", mode: "once" }))).toBe(false);
    expect(canShip(buildStateFrom({ id: "b", status: "verifying", mode: "session" }))).toBe(false);
    expect(startsNewBuild(buildStateFrom({ id: "b", status: "verifying" }))).toBe(false);
    expect(startsNewBuild(buildStateFrom({ id: "b", status: "failed" }))).toBe(true);
    expect(startsNewBuild(null)).toBe(true);
  });
});
