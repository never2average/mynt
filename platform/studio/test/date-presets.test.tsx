// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateRangeFilter, datePresets } from "@/components/filter-controls";

// Monday 23 November 2026, local time.
const NOW = new Date(2026, 10, 23, 15, 30);
const range = (future = false) => Object.fromEntries(datePresets(NOW, future).map((p) => [p.label, [p.from, p.to]]));

describe("the date range's quick choices", () => {
  afterEach(cleanup);

  it("past ranges for records, weeks starting on Monday", () => {
    expect(range()).toEqual({
      Today: ["2026-11-23", "2026-11-23"],
      "Last 7 days": ["2026-11-17", "2026-11-23"],
      "Last week": ["2026-11-16", "2026-11-22"],
      "Last 30 days": ["2026-10-25", "2026-11-23"],
      "Last month": ["2026-10-01", "2026-10-31"],
      "This month": ["2026-11-01", "2026-11-23"],
      "Year to date": ["2026-01-01", "2026-11-23"],
      "This year": ["2026-01-01", "2026-12-31"],
      "Last year": ["2025-01-01", "2025-12-31"],
    });
  });

  it("ranges ahead for due dates", () => {
    expect(range(true)).toEqual({
      Today: ["2026-11-23", "2026-11-23"],
      "This week": ["2026-11-23", "2026-11-29"],
      "Next week": ["2026-11-30", "2026-12-06"],
      "Next 30 days": ["2026-11-23", "2026-12-22"],
      "This month": ["2026-11-01", "2026-11-30"],
      "Next month": ["2026-12-01", "2026-12-31"],
      "Rest of this year": ["2026-11-23", "2026-12-31"],
      "This year": ["2026-01-01", "2026-12-31"],
    });
  });

  it("January's Last month is December of the year before", () => {
    const jan = Object.fromEntries(datePresets(new Date(2027, 0, 10)).map((p) => [p.id, [p.from, p.to]]));
    expect(jan["last-month"]).toEqual(["2026-12-01", "2026-12-31"]);
    expect(jan.ytd).toEqual(["2027-01-01", "2027-01-10"]);
  });

  it("picking one sets the range, and the button names it instead of two dates", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<DateRangeFilter label="Date range" from="" to="" onChange={onChange} now={NOW} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-filter="Date range"]')!));
    const quick = document.querySelector("[data-date-presets]")!;
    expect([...quick.querySelectorAll("[data-date-preset]")].map((b) => b.textContent)).toEqual(["Today", "Last 7 days", "Last week", "Last 30 days", "Last month", "This month", "Year to date", "This year", "Last year"]);
    await act(async () => void fireEvent.click(quick.querySelector('[data-date-preset="last-month"]')!));
    expect(onChange).toHaveBeenCalledWith("2026-10-01", "2026-10-31");
    rerender(<DateRangeFilter label="Date range" from="2026-10-01" to="2026-10-31" onChange={onChange} now={NOW} />);
    expect(document.querySelector('[data-filter="Date range"]')!.getAttribute("aria-label")).toBe("Date range: Last month");
    expect(document.querySelector('[data-date-preset="last-month"]')!.getAttribute("aria-pressed")).toBe("true");
    // A range picked on the calendar that isn't a quick choice still shows its dates.
    rerender(<DateRangeFilter label="Date range" from="2026-10-03" to="2026-10-09" onChange={onChange} now={NOW} />);
    expect(document.querySelector('[data-filter="Date range"]')!.getAttribute("aria-label")).toBe("Date range: 2026-10-03 – 2026-10-09");
  });
});
