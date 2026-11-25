// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The platform admin's Audit trails (list, filters, date presets, export, an entry's page with Details and Related),
// each firm's and workspace's Members tab with Invite member, Change role and Remove, the Overview's Invite person
// (email, what they join, their role there). Risk models and the Risk register are test/risk-models-page.test.tsx and
// test/risk-register-page.test.tsx.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { AuditListView, AuditDetailView } = await import("@/components/admin-audit");
const { FirmMembersTable, WorkspaceMembersTable, InviteWorkspaceMemberSheet, InvitePersonSheet, ChangeFirmRoleSheet, RemoveFirmMemberSheet } = await import("@/components/admin-members");
const { FirmDetailView } = await import("@/components/admin-firms");
const { WorkspaceDetailView } = await import("@/components/admin-workspaces");
const audit = await import("@/lib/admin-audit");
const members = await import("@/lib/admin-members");
const admin = await import("@/lib/admin");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const FIRM = "33333333-3333-4333-8333-333333333333";
const INV = "66666666-6666-4666-8666-666666666666";
const NOW = new Date(2026, 10, 23, 15, 30);

const fetcher = () => {
  const calls: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, message: "Done by Mynt." }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
};
const type = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } });
const click = async (sel: string) => act(async () => void fireEvent.click(document.querySelector(sel)!));
const submit = (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!));

const ENTRIES = audit.auditEntriesFrom(
  [
    { id: "a1", actor_email: "boss@example.com", action: "rotate_subscription_secret", target: "sub-1", details: { workspace_id: WS, api_key: "sk-never", note: "rotated" }, created_at: "2026-11-23T09:00:00.000Z", class: "security" },
    { id: "a2", actor_email: null, action: "set_entity_status", target: FIRM, details: { status: "suspended" }, created_at: "2026-11-10T09:00:00.000Z", class: "obligations" },
    { id: "a3", actor_email: "boss@example.com", action: "add_entity_member", target: FIRM, details: { email: "lee@example.com" }, created_at: "2025-06-01T09:00:00.000Z", class: "obligations" },
    { id: "a4", actor_email: "ana@example.com", action: "change_member_role", target: WS, details: { user_id: USER, from: "member", to: "admin" }, created_at: "2026-11-20T09:00:00.000Z", class: "workspace" },
  ],
  { workspaces: { [WS]: "Team" }, firms: { [FIRM]: "Acme Trust" } },
)!;
const DATA = { entries: ENTRIES, limit: 500 };

describe("Audit trails: the list", () => {
  it("one toolbar row (full-width search, Filters, the date range, labelled Import disabled with its reason, Export CSV) over the table", () => {
    const html = renderToStaticMarkup(<AuditListView data={DATA} onOpen={() => undefined} now={NOW} />);
    const toolbar = html.slice(html.indexOf("data-toolbar"), html.indexOf("data-table-view"));
    const order = ["Search the audit trail", "data-filters-menu-button", 'data-filter="When"', "data-import", "data-export"].map((s) => toolbar.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(toolbar).toMatch(/<button[^>]*disabled=""[^>]*title="Importing a CSV comes with Mynt&#x27;s next update."[^>]*data-import/);
    for (const s of ["When", "Action", "Class", "Actor", "Workspace / Firm", "Target", "Details"]) expect(html).toContain(`>${s}</th>`);
    // Readable actions, classes in words, places by name; a secret-looking detail is Hidden.
    for (const s of ["Rotate subscription secret", "App security", "Licence obligations", "Workspace: Team", "Firm: Acme Trust", "api_key: Hidden", "Mynt"]) expect(html).toContain(s);
    expect(html).not.toContain("sk-never");
  });

  it("filters by action, class, actor, workspace, firm and target type, as chips, over what was fetched", () => {
    const opts = audit.auditFacetOptions(ENTRIES);
    expect(opts.class.map((o) => o.value)).toEqual(["security", "obligations", "financial", "workspace"]);
    expect(opts.workspace).toEqual([{ value: WS, label: "Team" }]);
    expect(opts.firm).toEqual([{ value: FIRM, label: "Acme Trust" }]);
    expect(opts.targetType.map((o) => o.value)).toEqual(["workspace", "firm", "vendor"]);
    const ids = (f: Partial<import("@/lib/admin-audit").AuditFilters>) => audit.filterAudit(ENTRIES, { ...audit.NO_AUDIT_FILTERS, ...f }).map((e) => e.id);
    expect(ids({ class: ["obligations"] })).toEqual(["a2", "a3"]);
    expect(ids({ actor: ["Mynt"] })).toEqual(["a2"]);
    expect(ids({ firm: [FIRM], action: ["add_entity_member"] })).toEqual(["a3"]);
    expect(ids({ workspace: [WS] })).toEqual(["a1", "a4"]);
    expect(ids({ targetType: ["vendor"] })).toEqual(["a1"]);
    expect(ids({ query: "suspended" })).toEqual(["a2"]);
    expect(ids({ from: "2026-11-15", to: "2026-11-23" })).toEqual(["a1", "a4"]);
  });

  it("the date range's quick choices look back; picking Last 7 days narrows the table", async () => {
    render(<AuditListView data={DATA} onOpen={() => undefined} now={NOW} />);
    await click('[data-filter="When"]');
    const presets = [...document.querySelectorAll("[data-date-preset]")].map((b) => b.getAttribute("data-date-preset"));
    expect(presets).toEqual(["today", "last-7", "last-week", "last-30", "last-month", "this-month", "ytd", "this-year", "last-year"]);
    await click('[data-date-preset="last-7"]');
    expect([...document.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["a1", "a4"]);
    expect(document.querySelector('[data-filter="When"]')!.textContent).toContain("Last 7 days");
  });

  it("Export CSV downloads what's shown; a row opens its entry", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.push(b), "blob:x"), revokeObjectURL: () => undefined }));
    const opened: string[] = [];
    render(<AuditListView data={DATA} onOpen={(id) => opened.push(id)} now={NOW} />);
    type('input[aria-label^="Search the audit trail"]', "suspended");
    await click("[data-export]");
    const csv = await new Promise<string>((done) => {
      const r = new FileReader();
      r.onload = () => done(String(r.result));
      r.readAsText(blobs[0]);
    });
    expect(csv.split("\r\n")[0]).toBe(audit.AUDIT_CSV_HEAD.join(","));
    expect(csv).toContain("Set entity status");
    expect(csv).not.toContain("Rotate subscription secret");
    await click('[data-row="a2"]');
    expect(opened).toEqual(["a2"]);
  });
});

describe("Audit trails: an entry's page", () => {
  it("metadata card, then Details (every detail, secrets Hidden) and Related (same target, newest 50)", async () => {
    const entry = ENTRIES.find((e) => e.id === "a2")!;
    const related = audit.relatedEntries(ENTRIES, entry);
    expect(related.map((e) => e.id)).toEqual(["a3"]);
    const html = renderToStaticMarkup(<AuditDetailView entry={entry} related={related} onBack={() => undefined} onOpen={() => undefined} />);
    for (const s of ["data-metadata-card", "Back to audit trails", "Set entity status", "Licence obligations", "Acme Trust", 'data-detail-tab="details"', 'data-detail-tab="related"', "status", "suspended"]) expect(html).toContain(s);
    render(<AuditDetailView entry={entry} related={related} onBack={() => undefined} onOpen={() => undefined} />);
    await click('[data-detail-tab="related"]');
    expect(document.querySelector('[data-row="a3"]')!.textContent).toContain("Add entity member");
    const secret = renderToStaticMarkup(<AuditDetailView entry={ENTRIES[0]} related={[]} onBack={() => undefined} onOpen={() => undefined} />);
    expect(secret).toContain("Hidden");
    expect(secret).not.toContain("sk-never");
    expect(audit.RELATED_LIMIT).toBe(50);
  });
});

const FIRM_ROW: import("@/lib/admin").Firm = {
  id: FIRM,
  name: "Acme Trust",
  status: "active",
  legalForm: "company_private",
  country: "us",
  regions: ["US"],
  members: [{ id: USER, name: "Lee", email: "lee@example.com", roles: ["license_provider", "consumer"] }],
  licences: [],
  awaitingReview: 0,
  types: ["license_provider"],
  createdAt: null,
};
const WS_DETAIL = admin.workspaceDetailFrom({
  workspace: { id: WS, name: "Team", status: "active" },
  members: [{ user_id: USER, name: "Ana", email: "ana@example.com", role: "owner", joined_at: "2026-10-01T00:00:00.000Z" }],
  apps: [],
  invitations: [
    { id: INV, email: "new@example.com", role: "member", status: "open", created_at: "2026-11-01T00:00:00.000Z" },
    { id: "old", email: "gone@example.com", role: "member", status: "revoked" },
  ],
  activity: [],
})!;

describe("a firm's Members tab", () => {
  it("name, email, role, status in words, and each row's labelled Change role and Remove", () => {
    const html = renderToStaticMarkup(<FirmMembersTable firm={FIRM_ROW} />);
    for (const s of ["Lee", "lee@example.com", "Licence provider, Consumer", "Signed in", `data-change-role="${USER}"`, `data-remove-member="${USER}"`, ">Change role<", ">Remove<"]) expect(html).toContain(s);
  });

  it("Change role: the firm's roles become the ones picked; any other role stays (Mynt admin is never offered)", async () => {
    expect(members.firmRoleOptions(FIRM_ROW).map((o) => o.value)).toEqual(["license_provider"]);
    expect(members.firmRoleOptions({ types: [] }).map((o) => o.value)).toEqual(["developer", "vendor", "license_provider", "liquidity_provider"]);
    expect(members.firmRoleChange(["admin", "license_provider", "innovator"], ["vendor"])).toEqual({ roles: ["admin", "vendor"], already: ["admin", "license_provider", "innovator"], adding: ["vendor"], removing: ["license_provider", "developer"] });
    const { f, calls } = fetcher();
    render(<ChangeFirmRoleSheet firm={{ ...FIRM_ROW, types: ["license_provider", "vendor"] }} member={FIRM_ROW.members[0]} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    expect(document.querySelector('[data-role="admin"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-role="vendor"]')!);
    fireEvent.click(document.querySelector('[data-role="license_provider"]')!);
    expect(document.querySelector("[data-role-preview]")!.textContent).toContain("removing: Licence provider");
    await submit("[data-change-firm-role-form]");
    expect(calls).toEqual([{ url: `/api/admin/firms/${FIRM}/members`, body: { action: "change_role", email: "lee@example.com", roles: ["vendor"] } }]);
  });

  it("Remove: only once their email is typed again", async () => {
    const { f, calls } = fetcher();
    render(<RemoveFirmMemberSheet firm={FIRM_ROW} member={FIRM_ROW.members[0]} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    const button = document.querySelector<HTMLButtonElement>("[data-remove-firm-member-submit]")!;
    expect(button.disabled).toBe(true);
    type("[data-confirm-email]", "Lee@Example.com");
    expect(button.disabled).toBe(false);
    await submit("[data-remove-firm-member-form]");
    expect(calls).toEqual([{ url: `/api/admin/firms/${FIRM}/members`, body: { action: "remove", email: "lee@example.com", confirm_email: "lee@example.com" } }]);
  });

  it("the firm's page opens on the tab its address names", () => {
    const html = renderToStaticMarkup(<FirmDetailView detail={{ firm: FIRM_ROW, offerings: null, products: [] }} onBack={() => undefined} initialTab="products" />);
    expect(html).toMatch(/data-detail-tab="products"[^>]*>|aria-selected="true"[^>]*data-detail-tab="products"/);
    expect(html).toContain("This firm owns and sponsors no products.");
  });
});

describe("a workspace's Members tab", () => {
  it("members (Signed in) and open invitations (Invited, not yet signed in), each with Change role and Remove", () => {
    const rows = members.workspaceMemberRows(WS_DETAIL);
    expect(rows.map((r) => [r.kind, r.email, r.status])).toEqual([["member", "ana@example.com", "signed_in"], ["invite", "new@example.com", "invited"]]);
    const html = renderToStaticMarkup(<WorkspaceMembersTable detail={WS_DETAIL} />);
    for (const s of ["ana@example.com", "Owner", "Signed in", "new@example.com", "Invited, not yet signed in", ">Change role<", ">Remove<"]) expect(html).toContain(s);
    expect(html).not.toContain("gone@example.com");
    // An invitation's role is changed by inviting again: its Change role is disabled with why.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Withdraw the invitation and invite them again with another role"[^>]*data-change-role="i:/);
  });

  it("Invite member (role owner, admin or member), Change role, Remove (confirmed) and withdrawing an invitation post to the workspace's route", async () => {
    const { f, calls } = fetcher();
    render(<InviteWorkspaceMemberSheet workspace={WS_DETAIL.workspace} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    expect([...document.querySelectorAll("[data-workspace-role] option")].map((o) => o.getAttribute("value"))).toEqual(["owner", "admin", "member"]);
    type("[data-member-email]", "New@Example.com");
    fireEvent.change(document.querySelector("[data-workspace-role]")!, { target: { value: "admin" } });
    await submit("[data-invite-workspace-member-form]");
    cleanup();
    render(<WorkspaceMembersTable detail={WS_DETAIL} fetcher={f} />);
    await click(`[data-change-role="m:${USER}"]`);
    fireEvent.change(document.querySelector("[data-workspace-role]")!, { target: { value: "member" } });
    await submit("[data-change-workspace-role-form]");
    cleanup();
    render(<WorkspaceMembersTable detail={WS_DETAIL} fetcher={f} />);
    await click(`[data-remove-member="m:${USER}"]`);
    await submit("[data-remove-workspace-member-form]"); // not yet confirmed: nothing sent
    fireEvent.click(document.querySelector("[data-confirm-remove]")!);
    await submit("[data-remove-workspace-member-form]");
    cleanup();
    render(<WorkspaceMembersTable detail={WS_DETAIL} fetcher={f} />);
    await click(`[data-remove-member="i:${INV}"]`);
    expect(document.body.textContent).toContain("Withdraw invitation");
    fireEvent.click(document.querySelector("[data-confirm-remove]")!);
    await submit("[data-remove-workspace-member-form]");
    const url = `/api/admin/workspaces/${WS}/members`;
    expect(calls).toEqual([
      { url, body: { action: "invite", email: "new@example.com", role: "admin" } },
      { url, body: { action: "change_role", user_id: USER, role: "member" } },
      { url, body: { action: "remove", user_id: USER, confirm: true } },
      { url, body: { action: "revoke_invite", invite_id: INV } },
    ]);
  });

  it("the workspace's page has Invite member and a Members tab with the rows", () => {
    const html = renderToStaticMarkup(<WorkspaceDetailView detail={WS_DETAIL} onBack={() => undefined} />);
    for (const s of ["data-invite-workspace-member", "Invite member", "Invited, not yet signed in"]) expect(html).toContain(s);
    expect(html).not.toContain('data-detail-tab="invitations"');
  });
});

describe("the Overview's Invite person", () => {
  const places = { firms: [FIRM_ROW], workspaces: [{ id: WS, name: "Team", personal: false, status: "active", owner: null, members: 1, apps: 0, createdAt: null }, { id: "p", name: "Ana's space", personal: true, status: "active", owner: null, members: 1, apps: 0, createdAt: null }] };

  it("Joins: firms and team workspaces, found by typing", () => {
    expect(members.joinTargets(places.firms, places.workspaces).map((t) => `${t.kind}:${t.name}`)).toEqual(["firm:Acme Trust", "workspace:Team"]);
    expect(members.joinTargets(places.firms, places.workspaces, "tea").map((t) => t.id)).toEqual([WS]);
    expect(members.joinTargets(places.firms, places.workspaces, "workspace").map((t) => t.id)).toEqual([WS]);
  });

  it("email, then a firm with the firm's role: posts the firm's Invite member", async () => {
    const { f, calls } = fetcher();
    render(<InvitePersonSheet open onClose={() => undefined} places={places} fetcher={f} />);
    type("[data-person-email]", "new@example.com");
    type("[data-joins-search]", "acme");
    expect(document.querySelectorAll("[data-join]")).toHaveLength(1);
    await click(`[data-join="firm:${FIRM}"]`);
    expect(document.querySelector('[data-role="license_provider"]')).not.toBeNull();
    expect(document.querySelector("[data-workspace-role]")).toBeNull();
    await submit("[data-invite-person-form]");
    expect(calls).toEqual([{ url: `/api/admin/firms/${FIRM}/members`, body: { action: "invite", email: "new@example.com", roles: ["license_provider"] } }]);
  });

  it("email, then a workspace with its role: posts the workspace's Invite member; an email that isn't one sends nothing", async () => {
    const { f, calls } = fetcher();
    render(<InvitePersonSheet open onClose={() => undefined} places={places} fetcher={f} />);
    type("[data-person-email]", "not-an-email");
    type("[data-joins-search]", "team");
    await click(`[data-join="workspace:${WS}"]`);
    await submit("[data-invite-person-form]");
    expect(calls).toEqual([]);
    expect(document.querySelector("[data-email-invalid]")).not.toBeNull();
    type("[data-person-email]", "new@example.com");
    fireEvent.change(document.querySelector("[data-workspace-role]")!, { target: { value: "owner" } });
    await submit("[data-invite-person-form]");
    expect(calls).toEqual([{ url: `/api/admin/workspaces/${WS}/members`, body: { action: "invite", email: "new@example.com", role: "owner" } }]);
  });
});
