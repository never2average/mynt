// @vitest-environment jsdom
// The shared approval components (components/approval.tsx), the same on all three Earn tabs:
// ApprovalStatus (a dot and its words, the reason in its tooltip) and ApprovalSteps (each step
// done, current, to come, skipped, failed or declined; compact in a table cell, full in a sheet).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { APPROVAL_LABELS, ApprovalStatus, ApprovalSteps, linearSteps, type ApprovalState } from "@/components/approval";
import { poolApprovalSteps } from "@/components/earn-view";
import { fromPools } from "@/lib/liquidity";

afterEach(cleanup);

const status = () => document.querySelector("[data-approval-status]")!;
const states = () => [...document.querySelectorAll("[data-step]")].map((s) => `${s.getAttribute("data-step")}:${s.getAttribute("data-step-state")}`);

describe("ApprovalStatus", () => {
  it("is a dot and its words, one tone per state", () => {
    const tones: Record<ApprovalState, string> = { "needs-approval": "blue", sign: "blue", sending: "gray", done: "green", declined: "gray", blocked: "amber", failed: "red", waiting: "amber" };
    for (const [state, tone] of Object.entries(tones) as [ApprovalState, string][]) {
      render(<ApprovalStatus state={state} />);
      expect(status().textContent, state).toBe(APPROVAL_LABELS[state]);
      expect(status().getAttribute("data-tone"), state).toBe(tone);
      expect(status().getAttribute("data-approval-status")).toBe(state);
      // A status, never a badge.
      expect(status().closest('[data-slot="badge"]')).toBeNull();
      cleanup();
    }
    expect([APPROVAL_LABELS["needs-approval"], APPROVAL_LABELS.sign, APPROVAL_LABELS.sending, APPROVAL_LABELS.declined]).toEqual(["Needs your approval", "Sign in wallet", "Sending…", "Declined"]);
  });

  it("an error is red, its reason in the tooltip; a label replaces the words", () => {
    render(<ApprovalStatus state="failed" reason="Couldn't reach Mynt." />);
    expect(status().textContent).toBe("Failed");
    expect(status().getAttribute("title")).toBe("Couldn't reach Mynt.");
    expect(status().className).toContain("text-destructive");
    cleanup();
    render(<ApprovalStatus state="done" label="Proposed" data-x="1" />);
    expect(status().textContent).toBe("Proposed");
    expect(status().getAttribute("title")).toBe("Proposed");
    expect(status().getAttribute("data-x")).toBe("1");
  });
});

describe("ApprovalSteps", () => {
  it("linear steps: before the current one done, after it to come; past the end all done; stopped failed or declined", () => {
    const labels = ["Review", "Approve", "Done"];
    expect(linearSteps(labels, 0).map((s) => s.state)).toEqual(["current", "todo", "todo"]);
    expect(linearSteps(labels, 1).map((s) => s.state)).toEqual(["done", "current", "todo"]);
    expect(linearSteps(labels, 3).map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(linearSteps(labels, 1, "failed").map((s) => s.state)).toEqual(["done", "failed", "todo"]);
    expect(linearSteps(labels, 1, "declined").map((s) => s.state)).toEqual(["done", "declined", "todo"]);
  });

  it("full: an ordered list, every step named, the current one marked as the current step", () => {
    render(<ApprovalSteps steps={linearSteps(["Review", "Approve", "Sign in wallet", "Done"], 2)} />);
    const list = document.querySelector("[data-approval-steps]")!;
    expect(list.tagName).toBe("OL");
    expect(list.getAttribute("data-approval-steps")).toBe("full");
    expect(states()).toEqual(["Review:done", "Approve:done", "Sign in wallet:current", "Done:todo"]);
    expect(list.querySelector('[aria-current="step"]')!.textContent).toContain("Sign in wallet");
    expect(list.textContent).toContain("Review");
    expect(list.textContent).toContain("Done");
  });

  it("compact: one line of marks, each named in its tooltip, then the step it stands at", () => {
    render(<ApprovalSteps compact steps={[{ label: "Proposed", state: "done" }, { label: "Sponsor approved", state: "current", title: "waiting for the sponsor" }, { label: "Admin approved", state: "todo" }, { label: "Open", state: "todo" }]} />);
    const el = document.querySelector('[data-approval-steps="compact"]')!;
    expect(el.querySelector("[data-step-at]")!.textContent).toBe("Sponsor approved");
    expect(el.querySelector('[data-step="Sponsor approved"]')!.getAttribute("title")).toBe("Sponsor approved: waiting for the sponsor");
    expect(el.getAttribute("aria-label")).toBe("Proposed: done, Sponsor approved: waiting for the sponsor, Admin approved: to come, Open: to come");
    // Labels other than the current one are only in tooltips: the cell stays one line.
    expect(el.textContent).not.toContain("Proposed");
    expect(el.textContent).not.toContain("Admin approved");
    expect(states()).toEqual(["Proposed:done", "Sponsor approved:current", "Admin approved:todo", "Open:todo"]);
    cleanup();
    render(<ApprovalSteps compact steps={[{ label: "Proposed", state: "done" }, { label: "Sponsor approved", state: "done" }, { label: "Admin approved", state: "skipped" }, { label: "Open", state: "done" }]} />);
    expect(document.querySelector("[data-step-at]")!.textContent).toBe("Open");
  });
});

describe("a pool's approval steps (My pools' Approval column)", () => {
  const base = { product_id: "p", sponsor_entity_id: "22222222-2222-4222-8222-222222222222", sandbox: false, status: "open", min_reserve_bps: 2000, min_reserve_floor_cents: 0, notice_period_days: 30, min_commitment_cents: 100, max_commitment_cents: 200, deposit_rail_id: null, withdrawal_rail_id: null, approved_at: "2026-11-01T00:00:00Z", offering_cleared: true };
  const pool = (over: Record<string, unknown>) => fromPools([{ ...base, id: "11111111-1111-4111-8111-111111111111", name: "P", ...over }]).map((p) => ({ ...p, productLine: null, queueLength: null, health: null }))[0];
  const of = (over: Record<string, unknown>) => poolApprovalSteps(pool(over)).map((s) => s.state);

  it("follows Mynt's pool states: proposed, sponsor approved, admin cleared (skipped for sandbox), open", () => {
    expect(poolApprovalSteps(pool({})).map((s) => s.label)).toEqual(["Proposed", "Sponsor approved", "Admin approved", "Open"]);
    expect(of({ approved_at: null, status: "paused", pause_kind: "awaiting_approval", offering_cleared: false })).toEqual(["done", "current", "todo", "todo"]);
    expect(of({ status: "paused", pause_kind: "health", offering_cleared: false })).toEqual(["done", "done", "current", "todo"]);
    expect(of({ status: "paused", pause_kind: "health" })).toEqual(["done", "done", "done", "current"]);
    expect(of({})).toEqual(["done", "done", "done", "done"]);
    expect(of({ sandbox: true, offering_cleared: false })).toEqual(["done", "done", "skipped", "done"]);
    expect(of({ sandbox: true, approved_at: null, status: "paused", pause_kind: "awaiting_approval" })).toEqual(["done", "current", "skipped", "todo"]);
  });
});
