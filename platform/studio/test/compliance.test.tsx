import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import states10m from "us-atlas/states-10m.json";
import countries110m from "world-atlas/countries-110m.json";
import { AuditsView, NO_AUDIT_FILTERS } from "@/components/audits-view";
import { CoverageMap, StatePanel, US_COUNTRY_ID, usStatus } from "@/components/coverage-view";
import { rowsFromEvents } from "@/lib/audit-classes";
import { LicencesView, licencesCsv } from "@/components/licences-view";
import { NotAvailableYet } from "@/components/not-available";
import {
  allStates,
  expiryOf,
  FIPS_TO_CODE,
  filterLicences,
  isCalendarDate,
  STATE_NAMES,
  fromAudit,
  fromCoverage,
  fromLicences,
  NO_LICENCE_FILTERS,
  searchAudit,
  toCsv,
} from "@/lib/compliance";

const NOW = Date.parse("2026-11-13T00:00:00Z");

const coverage = fromCoverage({
  states: [
    {
      code: "ca",
      name: "California",
      status: "unlocked",
      partners: [{ entity_id: "e1", name: "Harbor Bank" }],
      licences: [{ type: "Money transmitter", number: "MT-1" }],
      products: [{ name: "Round-up savings" }],
      rails: ["ACH"],
    },
    { code: "NY", status: "available", partners: ["Harbor Bank"] },
    { code: "TX", status: "made-up" },
    { code: "Narnia", status: "unlocked" },
  ],
});

describe("coverage", () => {
  it("reads Mynt's states defensively", () => {
    expect(coverage.states.map((s) => [s.code, s.status])).toEqual([
      ["CA", "unlocked"],
      ["NY", "available"],
      ["TX", "unavailable"], // an unknown status is never read as unlocked
    ]);
    expect(coverage.states[0]).toMatchObject({ partners: [{ entityId: "e1", name: "Harbor Bank" }], licences: ["Money transmitter · MT-1"], products: ["Round-up savings"], rails: ["ACH"] });
    expect(coverage.states[1].name).toBe("New York");
    expect(fromCoverage(null)).toEqual({ states: [] });
  });

  it("covers every state and DC, unavailable unless Mynt says otherwise", () => {
    const all = allStates(coverage);
    expect(all).toHaveLength(51);
    expect(all.find((s) => s.code === "WY")?.status).toBe("unavailable");
  });

  it("draws the US map with every state, a legend with counts and the US / World selector", () => {
    const html = renderToStaticMarkup(<CoverageMap coverage={coverage} region="us" onRegion={() => undefined} />);
    expect(html).toContain('data-legend="unlocked"');
    expect(html).toMatch(/Unlocked<\/span><span[^>]*>1</);
    expect(html).toMatch(/Available<\/span><span[^>]*>1</);
    expect(html).toMatch(/Unavailable<\/span><span[^>]*>49</);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-region="us"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-region="world"/);
    expect(html).toContain('aria-label="Map of US states by coverage"');
  });

  it("uses one set of status colours, light and dark, in the legend, list and panel", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("app/globals.css", "utf8");
    for (const s of ["unlocked", "available", "unavailable"]) expect(css.match(new RegExp(`--coverage-${s}: #[0-9a-f]{6};`, "g")), s).toHaveLength(2);
    const html = renderToStaticMarkup(<CoverageMap coverage={coverage} region="us" onRegion={() => undefined} />) + renderToStaticMarkup(<StatePanel state={coverage.states[0]} />);
    for (const s of ["unlocked", "available", "unavailable"]) expect(html).toContain(`background:var(--coverage-${s})`);
  });

  it("finds every state and DC on the us-atlas map, by FIPS code", () => {
    const topo = states10m as unknown as { objects: { states: { geometries: { id: string }[] } } };
    const codes = topo.objects.states.geometries.map((g) => FIPS_TO_CODE[g.id]).filter(Boolean);
    expect(new Set(codes)).toEqual(new Set(Object.keys(STATE_NAMES)));
  });

  it("has a side panel naming partners, licences, products and rails", () => {
    const panel = renderToStaticMarkup(<StatePanel state={coverage.states[0]} />);
    for (const t of ["Partners", "Licences", "Products", "Money rails", "Harbor Bank", "Money transmitter · MT-1", "Round-up savings", "ACH"]) expect(panel).toContain(t);
    expect(renderToStaticMarkup(<StatePanel state={allStates(coverage).find((s) => s.code === "WY")!} />)).toContain("No partner licensed here yet");
  });

  it("World: the legend says the US's status and that every other country is Not available (the map itself: test/coverage-map.test.tsx)", () => {
    const topo = countries110m as unknown as { objects: { countries: { geometries: { id?: string }[] } } };
    expect(topo.objects.countries.geometries.some((g) => g.id === US_COUNTRY_ID)).toBe(true);
    expect(usStatus(allStates(coverage))).toBe("unlocked");
    expect(usStatus(allStates(fromCoverage({ states: [{ code: "NY", status: "available" }] })))).toBe("available");
    expect(usStatus(allStates(fromCoverage({ states: [] })))).toBe("unavailable");
    const html = renderToStaticMarkup(<CoverageMap coverage={coverage} region="world" onRegion={() => undefined} />);
    expect(html).toContain("United States: Unlocked");
    expect(html).toContain("Every other country: Not available (Mynt serves the US only)");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-region="world"/);
  });
});

const licences = fromLicences({
  licences: [
    { partner: "Harbor Bank", type: "Money transmitter", regulator: "CA DFPI", number: "MT-1", states: ["ca"], status: "active", expires_at: "2027-06-01" },
    { partner: "Harbor Bank", type: "Lender", regulator: "NY DFS", number: "L-2", states: ["NY", "NJ"], status: "active", expires_at: "2026-12-01" },
    { partner: { name: "Prairie Trust" }, type: "Money transmitter", regulator: "TX DOB", number: "MT-3", states: ["TX"], status: "active", expires_at: "2026-10-01" },
    { partner: "Prairie Trust", type: "Lender", regulator: "TX OCCC", number: "L-4", states: ["TX"], status: "suspended", expires_at: null },
  ],
});

describe("licences", () => {
  it("reads the licences and marks expired and expiring ones", () => {
    expect(licences[0]).toMatchObject({ partner: "Harbor Bank", states: ["CA"], expiresAt: "2027-06-01" });
    expect(licences[2].partner).toBe("Prairie Trust");
    expect(licences.map((l) => expiryOf(l, NOW))).toEqual([null, "expiring", "expired", null]);
  });

  it("searches and filters by status, regulator and state", () => {
    const f = (o: Partial<typeof NO_LICENCE_FILTERS>) => filterLicences(licences, { ...NO_LICENCE_FILTERS, ...o }, NOW).map((l) => l.number);
    expect(f({ query: "prairie" })).toEqual(["MT-3", "L-4"]);
    expect(f({ status: "expired" })).toEqual(["MT-3"]);
    expect(f({ status: "expiring" })).toEqual(["L-2"]);
    expect(f({ status: "suspended" })).toEqual(["L-4"]);
    expect(f({ regulator: "NY DFS" })).toEqual(["L-2"]);
    expect(f({ state: "NJ" })).toEqual(["L-2"]);
    expect(f({ partner: "Prairie Trust" })).toEqual(["MT-3", "L-4"]);
    // Expiring within N days: not yet expired, and due within the window.
    expect(f({ within: "30" })).toEqual(["L-2"]);
    expect(f({ within: "365" })).toEqual(["MT-1", "L-2"]);
    expect(f({ within: "" })).toHaveLength(4);
  });

  it("highlights expired and expiring rows with words, not colour alone", () => {
    const html = renderToStaticMarkup(<LicencesView licences={licences} now={NOW} />);
    expect(html).toMatch(/<tr[^>]*data-expiry="expired"[\s\S]*?Expired/);
    expect(html).toMatch(/<tr[^>]*data-expiry="expiring"[\s\S]*?Expires soon/);
    for (const t of ["Search licences", "All partners", "All statuses", "All regulators", "All states", "Any expiry", "Expiring within 90 days", "4 of 4"]) expect(html).toContain(t);
  });

  it("has one toolbar row beside the search: filters, Import, Export, Invite partner and the view toggle", () => {
    const html = renderToStaticMarkup(<LicencesView licences={licences} now={NOW} />);
    const bar = html.slice(html.indexOf("data-toolbar"), html.indexOf("data-table-view"));
    const order = ['aria-label="Search licences"', 'aria-label="Partner"', 'aria-label="Regulator"', 'aria-label="State"', 'aria-label="Status"', 'aria-label="Expiring within"', "data-import", "data-export", "data-invite-partner", "data-view-toggle"];
    const at = order.map((t) => bar.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // Import isn't in Mynt yet: disabled, saying so. Export and Invite partner are labelled.
    expect(bar).toMatch(/<button[^>]*disabled=""[^>]*title="Coming with Mynt&#x27;s next update"[^>]*data-import/);
    expect(bar).toMatch(/data-export[^>]*>[\s\S]*?Export</);
    expect(bar).toMatch(/data-invite-partner[^>]*>[\s\S]*?Invite partner</);
    // The toggle: an icon button named for the view it opens.
    expect(bar).toMatch(/aria-label="Map view"[^>]*data-view-toggle="map"/);
    const map = renderToStaticMarkup(<LicencesView licences={licences} now={NOW} view="map" coverage={{ kind: "ready", data: coverage }} />);
    expect(map).toMatch(/aria-label="Table view"[^>]*data-view-toggle="table"/);
    expect(map).toContain("data-map-view");
    expect(map).not.toContain("data-table-view");
    expect(map).toContain('aria-label="Search licences"'); // the filters stay
  });

  it("exports the filtered rows", () => {
    const csv = licencesCsv(filterLicences(licences, { ...NO_LICENCE_FILTERS, partner: "Harbor Bank" }, NOW));
    expect(csv.split("\n")).toEqual(["Partner,Type,Regulator,Number,States,Status,Expires", "Harbor Bank,Money transmitter,CA DFPI,MT-1,CA,active,2027-06-01", "Harbor Bank,Lender,NY DFS,L-2,NY NJ,active,2026-12-01"]);
  });

  it("says when there are none", () => {
    expect(renderToStaticMarkup(<LicencesView licences={[]} now={NOW} />)).toContain("No licences yet");
  });
});

const page = fromAudit({
  events: [
    { at: "2026-11-12T10:00:00Z", actor: { id: "u1", name: "Ines Diaz" }, action: "app.created", target: { type: "app", id: "a1", name: "Round-up savings" }, details: { product_ids: ["p1"] } },
    { at: "2026-11-12T11:00:00Z", actor: { id: "u2", name: "Sam Lee" }, action: "member.invited", target: { type: "user", id: "u9" }, details: "as member" },
    { actor: { id: "u2" }, action: "no time" },
  ],
  next_cursor: "c2",
});

describe("audits", () => {
  it("reads events and the next cursor, dropping malformed ones", () => {
    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toBe("c2");
    expect(page.events[0].details).toBe('{"product_ids":["p1"]}');
    expect(fromAudit({})).toEqual({ events: [], nextCursor: null });
  });

  it("searches the page shown", () => {
    expect(searchAudit(page.events, "sam").map((e) => e.action)).toEqual(["member.invited"]);
    expect(searchAudit(page.events, "round-up").map((e) => e.action)).toEqual(["app.created"]);
  });

  it("renders the table with filters, pagination and Export", () => {
    const html = renderToStaticMarkup(
      <AuditsView rows={rowsFromEvents(page.events)} filters={NO_AUDIT_FILTERS} onFilters={() => undefined} members={[{ id: "u1", name: "Ines Diaz" }]} apps={[{ id: "a1", name: "Round-up savings" }]} actions={["app.created"]} page={1} hasNext onPrev={() => undefined} onNext={() => undefined} />,
    );
    for (const t of ["All actions", "All members", "All apps", "From", "To", "Export CSV", "Page 1", "2026-11-12 10:00 UTC", "app: Round-up savings", "user: u9"]) expect(html).toContain(t);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Previous/);
  });
});

describe("audit dates", () => {
  it("accept only real calendar dates", () => {
    for (const ok of ["2026-11-13", "2024-02-29"]) expect(isCalendarDate(ok), ok).toBe(true);
    for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-1", "yesterday", ""]) expect(isCalendarDate(bad), bad).toBe(false);
  });
});

describe("export and empty states", () => {
  it("writes CSV that a spreadsheet won't run as a formula", () => {
    expect(toCsv(["a", "b"], [["=1+1", 'say "hi", ok'], [null, "x"]])).toBe('a,b\n\'=1+1,"say ""hi"", ok"\n,x');
  });

  it("says a page isn't available yet, never an empty map", () => {
    expect(renderToStaticMarkup(<NotAvailableYet what="Coverage" />)).toContain("Coverage isn&#x27;t available yet");
  });
});
