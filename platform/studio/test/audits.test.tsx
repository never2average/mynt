// @vitest-environment jsdom
// The Audits page's Filters popovers: one Filters button per tab with the count, a heading per
// facet, chips that pick any number within a facet (any of them) and narrow across facets (all
// of them), one Clear all; Mynt is asked for one pick per facet, and ?action= still opens
// Workspace activity filtered to it.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useState } from "react";

import { auditFiltersOn, auditQuery, auditRowMatches, AuditsView, NO_AUDIT_FILTERS, ObligationsView, type AuditFilters } from "@/components/audits-view";
import { fromClassAudit, fromObligations } from "@/lib/audit-classes";
import { clearAll, filtersButton, headings, oneFiltersButton, openFilters, toggle } from "./facet-helpers";

afterEach(cleanup);

const rows = fromClassAudit({
  rows: [
    { id: "r1", at: "2026-11-12T10:00:00Z", class: "security", kind: "build.audit_finding", actor: { id: "u1", name: "Ines" }, app_id: "a1", summary: "Secret written to logs", severity: "high", status: "open" },
    { id: "r2", at: "2026-11-11T10:00:00Z", class: "security", kind: "program.gate", actor: { id: "u2", name: "Sam" }, app_id: "a2", summary: "Upgrade timelock missing", severity: "medium", status: "blocked" },
    { id: "r3", at: "2026-11-10T10:00:00Z", class: "security", kind: "build.audit_finding", actor: { id: "u2", name: "Sam" }, app_id: "a2", summary: "Old dependency", severity: "low", status: "open" },
  ],
}).rows;

const apps = [
  { id: "a1", name: "Cards" },
  { id: "a2", name: "Savings" },
];
const members = [
  { id: "u1", name: "Ines" },
  { id: "u2", name: "Sam" },
];

function Harness({ cls = "security", initial = NO_AUDIT_FILTERS, sent }: { cls?: "security" | "financial" | "workspace"; initial?: AuditFilters; sent?: string[] }) {
  const [filters, setFilters] = useState<AuditFilters>(initial);
  const query = auditQuery(cls, filters);
  sent?.push(query);
  // What Mynt returns for that query: its one action, member or app.
  const q = new URL(query, "http://localhost").searchParams;
  const fromMynt = rows.filter((r) => (!q.get("action") || r.kind === q.get("action")) && (!q.get("user_id") || r.actor.id === q.get("user_id")) && (!q.get("app_id") || r.appId === q.get("app_id")));
  return (
    <AuditsView
      auditClass={cls}
      rows={fromMynt}
      filters={filters}
      onFilters={setFilters}
      members={members}
      apps={apps}
      actions={["build.audit_finding", "program.gate"]}
      page={1}
      hasNext={false}
      onPrev={() => undefined}
      onNext={() => undefined}
    />
  );
}

const shown = () => [...document.querySelectorAll("tbody tr[data-audit-row]")].map((r) => r.textContent?.match(/Secret|timelock|dependency/)?.[0]);

describe("the Audits tabs' Filters popover", () => {
  it("App security: one Filters button; App, Kind, Severity, Status and Member as headings; any of within a facet, all across, one Clear all", async () => {
    const sent: string[] = [];
    const { container: c } = render(<Harness sent={sent} />);
    oneFiltersButton(c.querySelector("[data-toolbar]")!);
    expect(filtersButton(c).textContent).toBe("Filters");
    await openFilters(c);
    expect(headings()).toEqual(["App", "Kind", "Severity", "Status", "Member"]);
    await toggle("severity", "high");
    await toggle("severity", "low");
    expect(shown()).toEqual(["Secret", "dependency"]);
    await toggle("app", "a2");
    expect(shown()).toEqual(["dependency"]);
    expect(filtersButton(c).textContent).toBe("Filters· 3");
    // One app picked: Mynt is asked for it.
    expect(sent.at(-1)).toBe("/api/audit?class=security&app_id=a2");
    await toggle("app", "a1");
    // Two: Mynt is asked for every app, and the rows it returns are narrowed here.
    expect(sent.at(-1)).toBe("/api/audit?class=security");
    expect(shown()).toEqual(["Secret", "dependency"]);
    await toggle("member", "u2");
    expect(shown()).toEqual(["dependency"]);
    expect(sent.at(-1)).toBe("/api/audit?class=security&user_id=u2");
    await clearAll();
    expect(shown()).toHaveLength(3);
    expect(filtersButton(c).textContent).toBe("Filters");
    expect(sent.at(-1)).toBe("/api/audit?class=security");
  });

  it("Financial activity has Status but no Severity; Workspace activity calls Kind Action and has neither", async () => {
    render(<Harness cls="financial" />);
    await openFilters();
    expect(headings()).toEqual(["App", "Kind", "Status", "Member"]);
    cleanup();
    render(<Harness cls="workspace" />);
    await openFilters();
    expect(headings()).toEqual(["App", "Action", "Member"]);
  });

  it("several kinds narrow the page to any of them; ?action= (one value) still filters and is sent to Mynt", () => {
    const f = (o: Partial<AuditFilters>) => rows.filter((r) => auditRowMatches(r, { ...NO_AUDIT_FILTERS, ...o })).map((r) => r.id);
    expect(f({ action: ["program.gate", "build.audit_finding"], user_id: ["u1", "u9"] })).toEqual(["r1"]);
    expect(f({ action: "program.gate" })).toEqual(["r1", "r2", "r3"]); // one pick: Mynt already filtered by it
    expect(auditQuery("workspace", { ...NO_AUDIT_FILTERS, action: "member.invited" })).toBe("/api/audit?class=workspace&action=member.invited");
    expect(auditQuery("workspace", { ...NO_AUDIT_FILTERS, action: ["member.invited"], from: "2026-11-01", to: "2026-11-02" }, "c2")).toBe(
      "/api/audit?class=workspace&action=member.invited&from=2026-11-01&to=2026-11-02&cursor=c2",
    );
    expect([auditFiltersOn(NO_AUDIT_FILTERS), auditFiltersOn({ ...NO_AUDIT_FILTERS, action: "x" }), auditFiltersOn({ ...NO_AUDIT_FILTERS, from: "2026-11-01" })]).toEqual([false, true, true]);
  });

  it("the Audits page opens ?action= as one pick", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/(studio)/audits/page.tsx", "utf8");
    expect(page).toContain("action: initialAction ? [initialAction] : []");
    expect(page).toContain("auditQuery(auditClass, filters, cursor)");
  });
});

const obligations = fromObligations({
  obligations: [
    { licence_id: "l1", partner: { entity_id: "e1", name: "Harbor Bank" }, regulator: "CA DFPI", obligation_id: "CA-1", title: "Quarterly report", products: ["Cards"], status: "met" },
    { licence_id: "l1", partner: { entity_id: "e1", name: "Harbor Bank" }, regulator: "CA DFPI", obligation_id: "CA-2", title: "Annual audit", products: ["Cards"], status: "at_risk" },
    { licence_id: "l2", partner: { entity_id: "e2", name: "Prairie Trust" }, regulator: "TX DOB", obligation_id: "TX-1", title: "Surety bond", products: ["Savings"], status: "overdue" },
  ],
});

describe("Licence obligations' Filters popover", () => {
  it("Partner, Regulator, Status and Product as headings; any of within a facet, all across, one Clear all", async () => {
    const { container: c } = render(<ObligationsView obligations={obligations} />);
    oneFiltersButton(c.querySelector("[data-toolbar]")!);
    await openFilters(c);
    expect(headings()).toEqual(["Partner", "Regulator", "Status", "Product"]);
    const ids = () => [...c.querySelectorAll("tbody tr[data-obligation]")].map((r) => r.getAttribute("data-obligation"));
    await toggle("status", "met");
    await toggle("status", "overdue");
    expect(ids()).toEqual(["CA-1", "TX-1"]);
    await toggle("partner", "e1");
    expect(ids()).toEqual(["CA-1"]);
    expect(filtersButton(c).textContent).toBe("Filters· 3");
    await clearAll();
    expect(ids()).toEqual(["CA-1", "CA-2", "TX-1"]);
  });
});
