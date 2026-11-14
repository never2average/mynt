import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AuditsView, AuditTabs, CLASS_COLUMNS, NO_AUDIT_FILTERS, ObligationsView } from "@/components/audits-view";
import {
  AUDIT_CLASS_LABELS,
  auditClassOf,
  filterObligations,
  fromClassAudit,
  fromObligations,
  NO_OBLIGATION_FILTERS,
  rowsFromEvents,
  searchRows,
} from "@/lib/audit-classes";
import { fromAudit } from "@/lib/compliance";

const page = fromClassAudit({
  rows: [
    { id: "r1", at: "2026-11-12T10:00:00Z", class: "security", kind: "build.audit_finding", actor: { id: "u1", name: "Ines" }, app_id: "a1", target: { type: "build", id: "b1" }, summary: "Secret written to logs", severity: "high", status: "open" },
    { id: "r2", at: "2026-11-11T10:00:00Z", class: "security", kind: "program.gate", actor: "Mynt", app_id: "a1", target: { type: "program" }, summary: "Upgrade timelock missing", severity: "medium", status: "blocked" },
    { at: "2026-11-10T10:00:00Z", class: "made-up", action: "vuln.flag", summary: "Old dependency" },
    { id: "bad" },
  ],
  next_cursor: "c2",
});
const obligations = fromObligations({
  obligations: [
    { licence_id: "l1", partner: { entity_id: "e1", name: "Harbor Bank" }, licence_type: "Money transmitter", regulator: "CA DFPI", obligation_id: "CA-MT-Q", title: "Quarterly transaction report", products: ["Cards", { name: "Savings" }], status: "met", evidence: "Filed 2026-10-10" },
    { licence_id: "l1", partner: { entity_id: "e1", name: "Harbor Bank" }, licence_type: "Money transmitter", regulator: "CA DFPI", obligation_id: "CA-MT-AUD", title: "Annual audit", products: ["Cards"], status: "at_risk" },
    { licence_id: "l2", partner: { entity_id: "e2", name: "Prairie Trust" }, regulator: "TX DOB", obligation_id: "TX-1", title: "Surety bond renewal", products: [], status: "overdue" },
    { partner: { entity_id: "e2", name: "Prairie Trust" }, title: "Something", status: "nonsense", reason: "No evidence source connected for this obligation" },
    { status: "met" },
  ],
});

const view = (cls: "security" | "financial" | "workspace", rows = page.rows) =>
  renderToStaticMarkup(
    <AuditsView auditClass={cls} rows={rows} filters={NO_AUDIT_FILTERS} onFilters={() => undefined} members={[]} apps={[{ id: "a1", name: "Cards" }]} actions={["build.audit_finding"]} page={1} hasNext onPrev={() => undefined} onNext={() => undefined} />,
  );

describe("audit classes", () => {
  it("are four tabs, cleanly named; App security opens first", () => {
    const html = renderToStaticMarkup(<AuditTabs tab="security" onTab={() => undefined} />);
    expect([...html.matchAll(/role="tab" aria-selected="(true|false)" data-tab="(\w+)"/g)].map((m) => [m[2], m[1]])).toEqual([
      ["security", "true"],
      ["obligations", "false"],
      ["financial", "false"],
      ["workspace", "false"],
    ]);
    for (const l of Object.values(AUDIT_CLASS_LABELS)) expect(html).toContain(l);
    expect(Object.values(AUDIT_CLASS_LABELS)).toEqual(["App security", "Licence obligations", "Financial activity", "Workspace activity"]);
    expect([auditClassOf(undefined), auditClassOf("financial"), auditClassOf("x")]).toEqual(["security", "financial", "security"]);
  });

  it("read Mynt's classified rows, dropping malformed ones and unknown classes", () => {
    expect(page.rows.map((r) => [r.id, r.class, r.kind])).toEqual([
      ["r1", "security", "build.audit_finding"],
      ["r2", "security", "program.gate"],
      ["2026-11-10T10:00:00Z-2", null, "vuln.flag"],
    ]);
    expect(page.rows[1].actor).toEqual({ id: null, name: "Mynt" });
    expect(page.nextCursor).toBe("c2");
    expect(searchRows(page.rows, "timelock").map((r) => r.id)).toEqual(["r2"]);
  });

  it("App security: its own columns, severity and status in words, search, filters and Export", () => {
    const html = view("security");
    expect(CLASS_COLUMNS.security.map((c) => c.label)).toEqual(["When", "App", "Kind", "Summary", "Severity", "Status", "Who"]);
    for (const t of ["Secret written to logs", "Cards", "All kinds", "All members", "All apps", "All severities", "All statuses", "From", "To", "Export CSV", "Search the audit trail", "Page 1"]) expect(html).toContain(t);
    expect(html).toMatch(/data-tone="red"[^>]*>[\s\S]*?High/);
    expect(html).toMatch(/data-tone="amber"[^>]*>[\s\S]*?Medium/);
  });

  it("Financial activity and Workspace activity have their own columns", () => {
    expect(CLASS_COLUMNS.financial.map((c) => c.label)).toEqual(["When", "App", "Kind", "Summary", "Status", "Who", "Target"]);
    expect(CLASS_COLUMNS.workspace.map((c) => c.label)).toEqual(["When", "Who", "Action", "Target", "Summary"]);
    const fin = view("financial");
    expect(fin).not.toContain("All severities");
    expect(fin).toContain("All statuses");
    // Before Mynt classifies: the trail as it is, under Workspace activity.
    const trail = fromAudit({ events: [{ at: "2026-11-12T10:00:00Z", actor: { name: "Ines" }, action: "member.invited", target: { type: "user", id: "u9" } }] }).events;
    const ws = view("workspace", rowsFromEvents(trail));
    for (const t of ["All actions", "member.invited", "user: u9", "Ines"]) expect(ws).toContain(t);
  });

  it("Licence obligations: per licence and product, met / at risk / overdue in words, with evidence", () => {
    expect(obligations.map((o) => [o.obligationId, o.status])).toEqual([
      ["CA-MT-Q", "met"],
      ["CA-MT-AUD", "at_risk"],
      ["TX-1", "overdue"],
      ["obligation-3", "unknown"],
    ]);
    expect(obligations[0]).toMatchObject({ partner: "Harbor Bank", partnerId: "e1", licenceType: "Money transmitter", products: ["Cards", "Savings"], dueAt: null });
    expect(obligations[3].reason).toBe("No evidence source connected for this obligation");
    const html = renderToStaticMarkup(<ObligationsView obligations={obligations} />);
    expect(html).toMatch(/data-status="met"[\s\S]*?data-tone="green"[\s\S]*?Met/);
    expect(html).toMatch(/data-status="at_risk"[\s\S]*?data-tone="amber"[\s\S]*?At risk/);
    expect(html).toMatch(/data-status="overdue"[\s\S]*?data-tone="red"[\s\S]*?Overdue/);
    for (const t of ["Filed 2026-10-10", "No evidence recorded", "Cards, Savings", "Money transmitter", "All partners", "All regulators", "All statuses", "All products", "Export CSV", "4 of 4", "<th", "Reason"]) expect(html).toContain(t);
    // The partner filter is by entity id, shown by name; due dates Mynt doesn't set read "—".
    expect(html).toMatch(/<option value="e1">Harbor Bank<\/option>/);
    expect(html).toMatch(/data-status="met"[\s\S]*?tabular-nums">—</);
    // An Unknown one says why, in its own column and as the status's tooltip.
    expect(html).toMatch(/title="No evidence source connected for this obligation"[^>]*>Unknown</);
    expect(html).toMatch(/data-reason[^>]*>No evidence source connected for this obligation</);
    const f = (o: Partial<typeof NO_OBLIGATION_FILTERS>) => filterObligations(obligations, { ...NO_OBLIGATION_FILTERS, ...o }).map((x) => x.obligationId);
    expect(f({ status: "overdue" })).toEqual(["TX-1"]);
    expect(f({ product: "Savings" })).toEqual(["CA-MT-Q"]);
    expect(f({ partner: "e1", query: "audit" })).toEqual(["CA-MT-AUD"]);
    expect(f({ partner: "e2" })).toEqual(["TX-1", "obligation-3"]);
    expect(renderToStaticMarkup(<ObligationsView obligations={[]} />)).toContain("No obligations yet");
  });
});
