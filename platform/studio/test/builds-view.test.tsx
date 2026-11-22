// @vitest-environment jsdom
// The Builds page (/builds) in the dashboard's design: key figures, one toolbar row, a paged
// full-height table, status as a dot and words, and skeletons while loading.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { clearAll, filtersButton, headings, oneFiltersButton, openFilters, toggle } from "./facet-helpers";

vi.mock("next/navigation", () => ({
  usePathname: () => "/builds",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { BuildsView, buildKpis, filterBuilds, NO_BUILD_FILTERS } = await import("@/components/builds-view");

afterEach(cleanup);

const rows = [
  { appId: "a1", appName: "Round-up savings", id: "b1", title: "Add a card screen", status: "succeeded", updatedAt: "2026-11-12T10:00:00Z" },
  { appId: "a1", appName: "Round-up savings", id: "b2", title: "Fix the ledger sync", status: "failed", updatedAt: "2026-11-10T10:00:00Z" },
  { appId: "a2", appName: "Payroll advance", id: "b3", title: "Add onboarding", status: "coding", updatedAt: "2026-11-05T10:00:00Z" },
  { appId: "a2", appName: "Payroll advance", id: "b4", title: "Queue a check", status: "queued", updatedAt: "2026-10-20T10:00:00Z" },
];

describe("the Builds page", () => {
  it("shows key figures first, counted from the builds loaded; Not measured when they couldn't be loaded, never 0", () => {
    expect(buildKpis(rows).map((k) => [k.label, k.value])).toEqual([
      ["Builds", 4],
      ["Succeeded", 1],
      ["Failed", 1],
      ["Running", 2],
    ]);
    expect(buildKpis(null).map((k) => k.value)).toEqual([null, null, null, null]);
    const html = renderToStaticMarkup(<BuildsView rows={rows} />);
    expect(html).toContain("data-panel");
    expect(html.indexOf("data-kpis")).toBeLessThan(html.indexOf('aria-label="Search builds"'));
    const failed = renderToStaticMarkup(<BuildsView rows={[]} error="Your builds couldn't be loaded." />);
    expect(failed).toMatch(/data-kpi="builds"[\s\S]*?data-measured="false"[^>]*>Not measured</);
    expect(failed).toContain('role="alert"');
  });

  it("has one toolbar row: search, one Filters button, Date range, Export CSV, then New app as the primary call to action", () => {
    const html = renderToStaticMarkup(<BuildsView rows={rows} />);
    const bar = html.slice(html.indexOf("data-list-layout"), html.indexOf("<table"));
    const order = ['aria-label="Search builds"', "data-filters-menu-button", 'data-filter="Date range"', "data-export", "data-new-app"];
    const at = order.map((t) => bar.indexOf(t));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(bar).toMatch(/data-export[^>]*>[\s\S]*?Export CSV</);
    const cta = /<a[^>]*data-new-app[^>]*>/.exec(bar)![0];
    expect(cta).toContain('href="/new"');
    expect(cta).toContain('data-variant="default"');
    expect(html).not.toContain("<select");
  });

  it("lists builds with status as a dot and words, paged 25 at a time", () => {
    const html = renderToStaticMarkup(<BuildsView rows={rows} />);
    expect(html).toMatch(/data-status="succeeded"[\s\S]*?data-tone="green"[\s\S]*?Succeeded/);
    expect(html).toMatch(/data-status="failed"[\s\S]*?data-tone="red"[\s\S]*?Failed/);
    expect(html).toMatch(/data-status="coding"[\s\S]*?data-tone="amber"[\s\S]*?Coding/);
    expect(html).toContain('href="/a1/b1"');
    expect(html).toMatch(/<thead[^>]*class="[^"]*sticky/);
    const many = Array.from({ length: 30 }, (_, i) => ({ ...rows[0], id: `b${i}` }));
    const paged = renderToStaticMarkup(<BuildsView rows={many} />);
    expect(/<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(paged)![1].match(/<tr/g)).toHaveLength(25);
    expect(paged).toContain("30 rows · Page 1 of 2");
  });

  it("filters by app, status, the build's date and words", () => {
    const f = (o: Partial<typeof NO_BUILD_FILTERS>) => filterBuilds(rows, { ...NO_BUILD_FILTERS, ...o }).map((r) => r.id);
    expect(f({ appId: "a2" })).toEqual(["b3", "b4"]);
    expect(f({ status: "failed" })).toEqual(["b2"]);
    expect(f({ from: "2026-11-01", to: "2026-11-30" })).toEqual(["b1", "b2", "b3"]);
    expect(f({ to: "2026-10-31" })).toEqual(["b4"]);
    expect(f({ query: "ledger" })).toEqual(["b2"]);
    expect(f({ query: "payroll onboarding" })).toEqual(["b3"]);
  });

  it("narrows the table from the toolbar's App filter", async () => {
    const { container: c } = render(<BuildsView rows={rows} />);
    expect(c.querySelectorAll("tbody tr")).toHaveLength(4);
    await openFilters(c);
    await toggle("app", "a1");
    expect(c.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(c.textContent).toContain("2 rows · Page 1 of 1");
  });

  it("puts App and Status in one Filters popover: any of the picks within a facet, every facet, and one Clear all", async () => {
    const { container: c } = render(<BuildsView rows={rows} />);
    oneFiltersButton(c.querySelector("[data-list-layout]") ?? c);
    expect(filtersButton(c).textContent).toBe("Filters");
    await openFilters(c);
    expect(headings()).toEqual(["App", "Status"]);
    const ids = () => [...c.querySelectorAll("tbody tr[data-build]")].map((r) => r.getAttribute("data-build"));
    await toggle("status", "succeeded");
    await toggle("status", "queued");
    expect(ids()).toEqual(["b1", "b4"]); // any of the statuses
    expect(filtersButton(c).textContent).toBe("Filters· 2");
    await toggle("app", "a2");
    expect(ids()).toEqual(["b4"]); // and the app
    expect(filtersButton(c).getAttribute("aria-label")).toBe("Filters: 3 on");
    await clearAll();
    expect(ids()).toHaveLength(4);
    expect(filtersButton(c).textContent).toBe("Filters");
  });

  it("filters by any of several apps or statuses, and still takes one value", () => {
    const f = (o: Partial<typeof NO_BUILD_FILTERS>) => filterBuilds(rows, { ...NO_BUILD_FILTERS, ...o }).map((r) => r.id);
    expect(f({ status: ["failed", "coding"] })).toEqual(["b2", "b3"]);
    expect(f({ appId: ["a1"], status: ["failed", "coding"] })).toEqual(["b2"]);
    expect(f({ appId: "a1", status: "" })).toEqual(["b1", "b2"]);
  });

  it("loads with skeletons, never Loading… text, and says when there are none", () => {
    const loading = renderToStaticMarkup(<BuildsView rows={null} />);
    expect(loading).toContain('data-slot="skeleton"');
    expect(loading).not.toMatch(/Loading/);
    expect(renderToStaticMarkup(<BuildsView rows={[]} />)).toContain("No builds yet");
    const page = readFileSync(join(process.cwd(), "app/(studio)/builds/page.tsx"), "utf8");
    expect(page).toContain("flex min-h-0 flex-1 flex-col overflow-y-auto");
    expect(page).toContain("gap-4 p-4 lg:gap-5 lg:p-6");
    expect(page).not.toMatch(/Loading builds/);
  });
});

const { metricsFrom, costOfCap, totalTime, durationText, phaseElapsed } = await import("@/lib/build-metrics");
const { BuildMeter } = await import("@/components/build-meter");
const { buildAveragesOf } = await import("@/lib/dashboard");
const { buildAverageKpis } = await import("@/lib/dashboard-visual");
const { KpiRow } = await import("@/components/charts");

describe("each build's cost and time", () => {
  // As get_build / list_builds report them.
  const finished = metricsFrom({
    cost_cents: 310,
    cap_cents: 2000,
    durations_seconds: { queued: 5, coding: 600, verify: 120, total: 725 },
    timing: { queued_at: "2026-11-12T10:00:00Z", started_at: "2026-11-12T10:00:05Z", coding_started_at: "2026-11-12T10:00:30Z", verify_started_at: "2026-11-12T10:10:30Z", finished_at: "2026-11-12T10:12:05Z" },
    measured_at: "2026-11-12T11:00:00Z",
    not_measured: {},
  });
  const running = metricsFrom({
    cost_cents: 125,
    cap_cents: 1000,
    durations_seconds: { queued: 5, coding: 60, verify: null, total: 90 },
    timing: { queued_at: "2026-11-12T10:00:00Z", started_at: "2026-11-12T10:00:05Z", coding_started_at: "2026-11-12T10:00:30Z", verify_started_at: null, finished_at: null },
    measured_at: "2026-11-12T10:01:30Z",
    not_measured: { "durations_seconds.verify": "Verification hasn't started" },
  });
  const unmeasured = metricsFrom({
    cost_cents: null,
    cap_cents: 1000,
    durations_seconds: { total: null },
    not_measured: { cost_cents: "Mynt didn't measure this build's cost before it ended", "durations_seconds.total": "Not recorded for this build" },
  });

  it("shows cost of cap and total time; a running build's time counts on from Mynt's measurement", () => {
    expect(costOfCap(finished).text).toBe("$3.10 of $20.00");
    expect(totalTime(finished, "succeeded", Date.parse("2026-11-20T00:00:00Z")).text).toBe("12m 05s");
    const at = Date.parse("2026-11-12T10:01:30Z");
    expect(totalTime(running, "coding", at).text).toBe("1m 30s");
    expect(totalTime(running, "coding", at + 45_000).text).toBe("2m 15s");
    expect(phaseElapsed(running, "coding", at + 45_000)).toBe(105);
    expect(durationText(3725)).toBe("1h 02m");
  });

  it("never shows an unmeasured figure as 0: Not measured, with Mynt's reason as its tooltip", () => {
    expect(costOfCap(unmeasured)).toEqual({ text: "Not measured", measured: false, reason: "Mynt didn't measure this build's cost before it ended" });
    expect(totalTime(null, "succeeded").measured).toBe(false); // an older Mynt that doesn't report them
    const withMetrics = [{ ...rows[0], metrics: finished }, { ...rows[1], metrics: unmeasured }, { ...rows[2], metrics: running }, rows[3]];
    const html = renderToStaticMarkup(<BuildsView rows={withMetrics} />);
    expect(html).toMatch(/<th[^>]*>Cost<\/th><th[^>]*>Time<\/th>/);
    expect(html).toMatch(/data-build="b1"[\s\S]*?data-field="cost">\$3\.10 of \$20\.00<[\s\S]*?data-field="time">12m 05s</);
    expect(html).toMatch(/data-build="b2"[\s\S]*?data-field="cost" data-not-measured="Mynt didn&#x27;t measure this build&#x27;s cost before it ended"[^>]*>Not measured</);
    expect(html).toMatch(/data-build="b3"[\s\S]*?data-live="true"/);
    expect(/data-build="b2"[\s\S]*?<\/tr>/.exec(html)![0]).not.toMatch(/\$0\.00|>0s</);
  });

  it("exports Cost and Time in the CSV", async () => {
    const blobs: Blob[] = [];
    const created = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:x";
    });
    URL.revokeObjectURL ??= () => undefined;
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { container: c } = render(<BuildsView rows={[{ ...rows[0], metrics: finished }, { ...rows[1], metrics: unmeasured }]} />);
    await act(async () => (c.querySelector("[data-export]") as HTMLButtonElement).click());
    created.mockRestore();
    clicked.mockRestore();
    const read = (b: Blob) =>
      new Promise<string>((done) => {
        const r = new FileReader();
        r.onload = () => done(String(r.result));
        r.readAsText(b);
      });
    const csv = (await Promise.all(blobs.map(read))).join("");
    expect(csv).toMatch(/Build,App,Status,Cost,Time,Updated/);
    expect(csv).toContain("$3.10 of $20.00,12m 05s");
    expect(csv).toContain("Not measured,Not measured");
  });

  it("the builder's line: phase, elapsed in it and cost of cap", () => {
    const html = renderToStaticMarkup(<BuildMeter build={{ id: "b3", status: "coding", metrics: running }} />);
    expect(html).toMatch(/data-field="phase">Coding<[\s\S]*?data-field="elapsed">\d+[hm] \d+[sm]<[\s\S]*?data-field="cost">\$1\.25 of \$10\.00</);
    const none = renderToStaticMarkup(<BuildMeter build={{ id: "b4", status: "failed", metrics: unmeasured }} />);
    expect(none).toMatch(/data-field="elapsed" data-not-measured="Not recorded for this build"/);
    expect(none).not.toContain("$0.00");
  });

  it("the dashboard averages this month's finished, measured builds; Not measured when there are none", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const avg = buildAveragesOf(
      {
        builds: [
          { status: "succeeded", created_at: "2026-11-12T10:00:00Z", cost_cents: 300, durations_seconds: { total: 600 } },
          { status: "failed", created_at: "2026-11-13T10:00:00Z", cost_cents: 100, durations_seconds: { total: null } },
          { status: "failed", created_at: "2026-11-14T10:00:00Z", cost_cents: null, durations_seconds: { total: 200 } },
          { status: "coding", created_at: "2026-11-15T10:00:00Z", cost_cents: 900, durations_seconds: { total: 50 } },
          { status: "succeeded", created_at: "2026-10-01T10:00:00Z", cost_cents: 5000, durations_seconds: { total: 9000 } },
        ],
      },
      now,
    );
    expect(avg).toEqual({ costCents: 200, seconds: 400, costCount: 2, timeCount: 2 });
    const kpis = buildAverageKpis(avg);
    expect(kpis.map((k) => [k.label, k.value])).toEqual([["Average build cost", 200], ["Average build time", 400]]);
    expect(renderToStaticMarkup(<KpiRow kpis={kpis} />)).toMatch(/\$2\.00[\s\S]*?6m 40s/);
    const none = buildAverageKpis(buildAveragesOf({ builds: [] }, now));
    expect(none.map((k) => k.value)).toEqual([null, null]);
    expect(renderToStaticMarkup(<KpiRow kpis={none} />).match(/data-measured="false"[^>]*>Not measured</g)).toHaveLength(2);
  });
});
