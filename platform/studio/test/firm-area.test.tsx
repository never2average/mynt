// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// My firm (/firm), a regulated firm's own area: the sidebar's My firm entry (only for the licence-provider role as
// granted), the firm's card with the real-company check's latest result, the onboarding checklist (each step's status
// in words, a labelled button where the studio can do it, what waits on Mynt), each tab's table in the list layout,
// and each sheet posting to its route with exactly what was typed.

vi.mock("next/navigation", () => ({
  usePathname: () => "/firm",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { SidebarView } = await import("@/components/app-sidebar");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { pageGateFor } = await import("@/components/studio-gates");
const { pageTitle, isAppPath } = await import("@/lib/studio-search");
const { FirmView, FirmChecklist, FirmCard } = await import("@/components/firm-area");
const { licenceFormProblem, partyFormProblem } = await import("@/components/firm-sheets");
const f = await import("@/lib/firm-area");
const { groupByStage } = await import("@/lib/workspaces");
const { NO_ACCESS } = await import("@/lib/liquidity");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const FIRM = "33333333-3333-4333-8333-333333333333";
const LIC = "44444444-4444-4444-8444-444444444444";
const LIC2 = "45454545-4545-4454-8454-454545454545";
const REQ = "55555555-5555-4555-8555-555555555555";
const SPON = "66666666-6666-4666-8666-666666666666";
const PARTY = "77777777-7777-4777-8777-777777777777";
const MEMBER = "88888888-8888-4888-8888-888888888888";
const LEI = "5493001KJTIIGC8Y1R12";

const step = (key: string, status: string, extra: Record<string, unknown> = {}) => ({ key, title: key, status, detail: `${key} in words.`, tool: null, by: "firm", informational: false, facts: {}, ...extra });
const CHECK_FACTS = { rule: "lei_or_msb", rule_text: "a matching GLEIF LEI record or a matching FinCEN MSB registration, and no mismatch or lapse", passes: false, reasons: ["gleif_lei: not found"], last_run_at: "2026-11-20T10:00:00Z", last_answer_at: "2026-11-20T10:00:00Z" };
const reply = (over: Record<string, unknown> = {}, check: Record<string, unknown> = {}) => ({
  entity: { id: FIRM, name: "Partner Trust", status: "active" },
  steps: [
    step("firm_registered", "done", { title: "Your firm is registered with Mynt", by: "admin" }),
    step("licence_provider_members", "done", {
      title: "People with the licence-provider role",
      by: "admin",
      facts: {
        members: 1,
        licence_providers: [{ name: "Lena", email: "lena@example.com", since: "2026-10-01T00:00:00Z" }],
        waiting: [{ request_id: MEMBER, email: "cy@example.com", requested_at: "2026-11-20T00:00:00Z", admin_recovery: false }],
        invited: [{ email: "ivy@example.com", invited_at: "2026-11-22T00:00:00Z" }],
      },
    }),
    step("firm_facts", "next", { title: "Firm facts for the real-company check", tool: "set_entity_facts" }),
    step("real_company_check", "blocked", { title: "Real-company check passed", by: "admin", tool: "run_firm_checks", detail: "Not passed. GLEIF's LEI record: not found (2026-11-20).", facts: { ...CHECK_FACTS, ...check } }),
    step("licences_registered", "not_started", { title: "Register your licences", tool: "register_license" }),
    step("licences_verified", "not_started", { title: "Licences verified by Mynt", tool: "register_license" }),
    step("roster_complete", "not_started", { title: "Roster filled for your licences", tool: "add_party" }),
    step("partner_ledger", "not_started", { informational: true, tool: "get_partner_kit" }),
    step("agreement_template", "not_started", { informational: true, tool: "upload_agreement_template" }),
    step("first_sponsorship", "not_started", { title: "First sponsorship approved", informational: true, tool: "approve_sponsorship", facts: { approved: 1, pending: 1 } }),
  ],
  progress: { done: 2, total: 7, next: { key: "firm_facts", title: "Firm facts for the real-company check", status: "next", tool: "set_entity_facts" }, complete: false },
  ready_to_sponsor: false,
  checks: [{ id: "c1", source: "gleif_lei", source_name: "GLEIF's LEI record", status: "not_found", status_words: "not found", at: "2026-11-20T10:00:00Z", note: null, scheduled: false }],
  ...over,
});
const ONBOARDING = f.fromOnboarding(reply())!;
const FIRM_RECORD = f.fromFirm({
  id: FIRM,
  name: "Partner Trust",
  status: "active",
  regions: ["US"],
  identifiers: [{ scheme: "lei", value: LEI }, { scheme: "us_ein", value: "12-3456789" }],
  members: [{ id: "u1", name: "Lena", email: "lena@example.com" }, { id: "u2", name: "Omar", email: "omar@example.com" }],
  licenses: [{ id: LIC, license_id: "fincen_msb" }, { id: LIC2, license_id: "state_mtl", jurisdiction: "us-ny" }],
  parties: [
    { id: PARTY, kind: "internal", person: { name: "Priya Shah" }, fills: [{ licence_id: LIC2, stakeholder: "qualified_individual" }], status: "active", since: "2026-01-01" },
    { id: "70707070-7070-4070-8070-707070707070", kind: "external", legal_entity_id: "x", legal_entity_name: "Audit LLP", fills: [], relationship: "statutory_audit", status: "ended", until: "2026-06-30" },
  ],
  reconciliation: { licences: [{ licence_id: LIC, license_id: "fincen_msb", missing: [{ stakeholder: "fincen_aml_compliance_officer", name: "AML compliance officer", kind: "internal" }] }] },
})!;
const LICENCES = f.fromLicences({
  licences: [
    { id: LIC, region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "31000123", status: "verified", in_force: true, covers: [], sponsorships: [] },
    { id: LIC2, region: "US", regulator_id: "nydfs", license_id: "state_mtl", jurisdiction: "us-ny", registration_number: "MT-1", status: "pending", in_force: false, covers: ["us-ny"], sponsorships: [] },
  ],
})!;
const REQUESTS = f.fromSponsorships([
  { id: REQ, status: "pending", product: { id: "dollar-send", name: "Dollar Send", status: "draft" }, component: { key: "transmission", primitive: "money_transmission", action: "issuance" }, builder: { name: "Builder Inc" }, requested_jurisdictions: ["us-ny", "us-ca"], note: "Launching in March", created_at: "2026-11-21T00:00:00Z", your_licences_granting_it: [{ id: LIC, license_id: "fincen_msb", in_force: true }, { id: LIC2, license_id: "state_mtl", jurisdiction: "us-ny", in_force: false }] },
])!;
const SPONSORED = f.fromSponsorships([
  { id: SPON, status: "approved", product: { id: "pay", name: "Pay", status: "published", drifted: true }, component: { key: "transmission" }, builder: { name: "Other Inc" }, jurisdictions: ["us-ny"], decided_at: "2026-11-01T00:00:00Z", licences: [{ id: LIC2, license_id: "state_mtl", jurisdiction: "us-ny" }] },
])!;
const TYPES = [
  { region: "US", regulatorId: "fincen", regulator: "FinCEN", id: "fincen_msb", name: "MSB registration", perJurisdiction: false, jurisdictions: [] },
  { region: "US", regulatorId: "nydfs", regulator: "NYDFS", id: "state_mtl", name: "State licence", perJurisdiction: true, jurisdictions: ["us-ny", "us-ca"] },
];
const DATA = { onboarding: ONBOARDING, firm: FIRM_RECORD, licences: LICENCES, requests: REQUESTS, sponsored: SPONSORED, licenceTypes: TYPES };
const NOTICES = f.fromNotices([{ id: "n1", type: "partner_ledger.source_changed", data: { source: "sandbox", by: "admin", nested: { secret: 1 } }, at: "2026-11-20T09:30:00Z", read: true }])!;

const fetcher = (answer: Record<string, unknown> = { ok: true, message: "Done by Mynt." }, status = 200) => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  });
  return { f: fn as unknown as typeof fetch, calls };
};
const q = (sel: string) => document.querySelector(sel);
const type = (sel: string, value: string) => fireEvent.change(q(sel)!, { target: { value } });
const click = async (sel: string) => act(async () => void fireEvent.click(q(sel)!));
const submit = async (sel: string) => act(async () => void fireEvent.submit(q(sel)!));
const tab = (t: Parameters<typeof FirmView>[0]["initialTab"]) => renderToStaticMarkup(<FirmView data={DATA} initialTab={t} notices={NOTICES} />);

const sidebar = (firm: boolean, developer = true, licenceProvider = false) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarView
          workspaces={[{ id: "w1", name: "Acme", role: "owner" }]}
          selected={{ id: "w1", name: "Acme", role: "owner" }}
          supported
          groups={groupByStage([])}
          account={{ name: null, email: null }}
          pathname="/firm"
          onSelectWorkspace={() => undefined}
          onCreateWorkspace={async () => null}
          developer={developer}
          licenceProvider={licenceProvider}
          firm={firm}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );

describe("the sidebar's My firm", () => {
  it("is there only for accounts granted the licence-provider role, marked current on /firm", () => {
    expect(sidebar(true)).toMatch(/href="\/firm"[^>]*>[\s\S]*?My firm/);
    expect(sidebar(true)).toMatch(/data-active="true"[^>]*href="\/firm"|href="\/firm"[^>]*data-active="true"/);
    expect(sidebar(false)).not.toContain('href="/firm"');
    expect(sidebar(false)).not.toContain("My firm");
    // An admin's roles imply licence provider (the Licences page) without the role being granted: no My firm.
    expect(sidebar(false, true, true)).not.toContain("My firm");
    // A licence provider without the developer role: Dashboard, Licences and My firm, no workspaces or apps.
    const only = sidebar(true, false, true);
    expect(only).toContain("My firm");
    expect(only).toContain('href="/licences"');
    expect(only).not.toContain('href="/marketplace"');
  });

  it("opens for licence providers without the developer role or a workspace; it's a fixed page titled My firm, never an app", () => {
    const only = { developer: false, liquidity: NO_ACCESS, owner: null, licenceProvider: true, firm: true };
    expect(pageGateFor("/firm", only, false)).toBe("none");
    expect(pageGateFor("/", only, false)).toBe("developer");
    expect(pageGateFor("/firm", { ...only, firm: false }, false)).toBe("developer");
    expect(pageGateFor("/firm", { ...only, developer: true }, true)).toBe("none");
    expect(pageTitle("/firm")).toBe("My firm");
    expect(isAppPath("/firm")).toBe(false);
  });
});

describe("the firm's card and the real-company check", () => {
  it("shows the firm's facts, its id to share, and the check's latest result in words with a mark and when", () => {
    const html = renderToStaticMarkup(<FirmCard data={DATA} onFacts={() => undefined} />);
    expect(html).toContain("Partner Trust");
    expect(html).toContain(LEI);
    expect(html).toContain(">Not recorded<"); // no FinCEN MSB number or NMLS ID on record
    expect(html).toContain(FIRM);
    expect(html).toMatch(/Can sponsor now<\/dt><dd[^>]*>Not yet</);
    expect(html).toContain('data-real-company-check="not_passed"');
    expect(html).toContain("Real-company check: Not passed. Not passed. GLEIF&#x27;s LEI record: not found (2026-11-20). Last asked 2026-11-20.");
    expect(html).toMatch(/data-step-status="blocked"[^>]*><svg[\s\S]*?<\/svg>Waiting<\/span>/);
    expect(html).toMatch(/data-set-firm-facts[\s\S]*?Set firm facts/);
  });

  it("says each state in words: passed, not run yet, the registers unreachable, not required, and unknown", () => {
    const line = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const o = f.fromOnboarding(reply())!;
      return f.checkLine({ ...o.check!, ...check, ...extra } as typeof o.check);
    };
    expect(line({ passes: true, status: "done", detail: "Passed." })).toBe("Real-company check: Passed. Passed.");
    expect(line({ lastRunAt: null, lastAnswerAt: null, detail: "Mynt hasn't run it yet." })).toBe("Real-company check: Not run yet. Mynt hasn't run it yet.");
    expect(line({ lastAnswerAt: null, detail: "The registers couldn't be reached." })).toBe("Real-company check: Not known yet. The registers couldn't be reached.");
    expect(line({ passes: null, status: "done", detail: "This server doesn't require it." })).toBe("Real-company check: Not required on this Mynt. This server doesn't require it.");
    expect(f.checkLine(null)).toBe("Real-company check: Mynt didn't say where it stands.");
    // A check this Mynt doesn't run is never read as a pass.
    expect(f.fromOnboarding(reply({}, { passes: null }))!.check!.passes).toBeNull();
    expect(renderToStaticMarkup(<FirmCard data={{ ...DATA, onboarding: f.fromOnboarding(reply({}, { passes: null }))! }} />)).toContain('data-real-company-check="not_measured"');
  });
});

describe("the onboarding checklist", () => {
  it("shows each step's status in words with a mark, never colour alone, and what waits on Mynt", () => {
    const html = renderToStaticMarkup(<FirmChecklist onboarding={ONBOARDING} />);
    expect(html).toContain("Getting ready to sponsor");
    expect(html).toContain("2 of 7 steps done · Next: Firm facts for the real-company check");
    for (const s of ["done", "next", "not_started", "blocked"]) expect(html).toContain(`data-step-status="${s}"`);
    for (const w of ["Done", "Do this next", "Not started", "Waiting"]) expect(html).toContain(`</svg>${w}</span>`);
    expect(html).toContain("Not passed. GLEIF&#x27;s LEI record: not found (2026-11-20).");
    expect(html.match(/\(for information\)/g)).toHaveLength(3);
    expect(html.match(/data-step=/g)).toHaveLength(10);
  });

  it("never shows a count Mynt didn't give as 0", () => {
    const o = f.fromOnboarding(reply({ progress: { next: null } }))!;
    expect(o.progress).toEqual({ done: null, total: null, next: null, complete: false });
    expect(f.progressWords(o.progress)).toBe("Not known");
    expect(f.progressWords({ done: 7, total: 7, next: null, complete: true })).toBe("All 7 steps done");
  });

  it("offers a labelled action where the studio can do the step; none where it waits on Mynt, is done, or stays with its own tool", () => {
    const html = renderToStaticMarkup(<FirmChecklist onboarding={ONBOARDING} onAction={() => undefined} />);
    expect(html).toMatch(/data-step="firm_facts"[\s\S]*?data-step-action="facts"[\s\S]*?Set firm facts/);
    expect(html).toMatch(/data-step="licences_registered"[\s\S]*?data-step-action="licence"[\s\S]*?Register licence/);
    expect(html).toMatch(/data-step="first_sponsorship"[\s\S]*?data-step-action="review"[\s\S]*?Review request/);
    expect(html.match(/data-step-action=/g)).toHaveLength(3);
    const s = (key: string, status: string, extra = {}) => f.fromOnboarding({ steps: [step(key, status, extra)] })!.steps[0]!;
    expect(f.stepAction(s("firm_facts", "not_started"))).toBe("facts");
    expect(f.stepAction(s("firm_facts", "done"))).toBeNull();
    expect(f.stepAction(s("real_company_check", "blocked", { by: "admin" }))).toBeNull();
    expect(f.stepAction(s("licences_verified", "next", { tool: "register_license" }))).toBe("licence");
    expect(f.stepAction(s("licences_verified", "blocked", { tool: "review_license", by: "admin" }))).toBeNull();
    expect(f.stepAction(s("roster_complete", "next"))).toBe("party");
    expect(f.stepAction(s("roster_complete", "not_started"))).toBeNull();
    expect(f.stepAction(s("first_sponsorship", "not_started", { tool: "approve_sponsorship", facts: { pending: 0 } }))).toBeNull();
    expect(f.stepAction(s("first_sponsorship", "not_started", { tool: "request_sponsorship", by: "builder" }))).toBeNull();
    expect(f.stepAction(s("partner_ledger", "not_started"))).toBeNull();
    expect(f.stepAction(s("agreement_template", "not_started"))).toBeNull();
    expect(Object.values(f.STEP_ACTION_LABELS)).toEqual(["Set firm facts", "Register licence", "Add party", "Review request"]);
  });

  it("a step's button opens its sheet", async () => {
    render(<FirmView data={DATA} notices={[]} />);
    await click('[data-step-action="facts"]');
    expect(q('[data-admin-sheet="firm-facts"]')).not.toBeNull();
    cleanup();
    render(<FirmView data={DATA} notices={[]} />);
    await click('[data-step-action="review"]');
    expect(q(`[data-review-request="${REQ}"]`)).not.toBeNull();
  });

  it("without a firm yet, every step waits on Mynt and nothing can be added", () => {
    const none = f.fromOnboarding({ entity: null, steps: [step("firm_registered", "blocked", { by: "admin", detail: "Waiting for Mynt to add your firm and you to it." })], progress: { done: 0, total: 7, next: null, complete: false } })!;
    const html = renderToStaticMarkup(<FirmView data={{ onboarding: none, firm: null, licences: [], requests: [], sponsored: [], licenceTypes: [] }} notices={[]} />);
    expect(html).toContain("Waiting for Mynt to add your firm and you to it.");
    expect(html).toContain("Mynt hasn&#x27;t added you to your firm yet.");
    expect(html).toMatch(/<button[^>]*data-register-licence[^>]*disabled|<button[^>]*disabled[^>]*data-register-licence/);
    expect(html).not.toContain("data-set-firm-facts");
    expect(html).not.toContain("data-real-company-check");
  });
});

describe("the tabs, each a table in the list layout", () => {
  it("the tab bar: Licences, Sponsorship requests, Sponsored products, Roster, People, Notices", () => {
    const html = tab("licences");
    expect([...html.matchAll(/data-firm-tab="([a-z]+)"/g)].map((m) => m[1])).toEqual(["licences", "requests", "sponsored", "roster", "people", "notices"]);
    expect(f.FIRM_TABS.map((t) => t.label)).toEqual(["Licences", "Sponsorship requests", "Sponsored products", "Roster", "People", "Notices"]);
    expect(f.firmTabOf("roster")).toBe("roster");
    expect(f.firmTabOf("nope")).toBe("licences");
    expect(html).toMatch(/role="tablist"/);
  });

  it("Licences: search, labelled Import and Export CSV, Register licence, then the table with each status in words", () => {
    const html = tab("licences");
    expect(html).toMatch(/data-toolbar[\s\S]*?Search your licences[\s\S]*?Import[\s\S]*?Export CSV[\s\S]*?Register licence/);
    for (const h of ["Licence", "Regulator", "Region", "Issued for", "Number", "Valid from", "Valid to", "Status", "Covers", "Sponsorships"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain("Verified by Mynt, in force");
    expect(html).toContain("Waiting for Mynt to verify");
    expect(html).toContain("Nowhere by itself");
    expect(f.licenceStatusWords({ status: "rejected", inForce: false, reviewNote: "not on the register", validTo: null })).toBe("Not verified by Mynt: not on the register");
    expect(f.licenceStatusWords({ status: "suspended", inForce: false, reviewNote: null, validTo: null })).toBe("Suspended by Mynt");
    expect(f.licenceStatusWords({ status: "verified", inForce: false, reviewNote: null, validTo: "2026-01-01" })).toBe("Verified by Mynt, not in force (valid to 2026-01-01)");
    expect(f.licencesCsv(LICENCES).split("\n")[2]).toBe("state_mtl,nydfs,US,us-ny,MT-1,,,Waiting for Mynt to verify,US-NY,0");
  });

  it("Sponsorship requests: those waiting with Review request, those approved with Revoke sponsorship; no generic call to action", () => {
    const html = tab("requests");
    for (const h of ["Product", "Component", "Builder", "Asked for", "Approved in", "Status", "Asked on"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toMatch(new RegExp(`Dollar Send[\\s\\S]*?Builder Inc[\\s\\S]*?US-NY, US-CA[\\s\\S]*?Waiting for your decision[\\s\\S]*?data-review="${REQ}"[\\s\\S]*?Review request`));
    expect(html).toMatch(new RegExp(`Pay[\\s\\S]*?Other Inc[\\s\\S]*?Approved[\\s\\S]*?data-revoke="${SPON}"[\\s\\S]*?Revoke sponsorship`));
    expect(html).not.toContain("data-register-licence");
    expect(html).not.toContain("data-add-party");
  });

  it("Sponsored products: read-only, each product's state in words, linking nowhere", () => {
    const html = tab("sponsored");
    for (const h of ["Product", "State", "Component", "Builder", "Under", "Where", "Since"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain("Drifted: new sales paused");
    expect(html).toContain("state_mtl (us-ny)");
    const from = html.indexOf("data-table-view");
    const table = html.slice(from, html.indexOf("</table>", from));
    expect(table).not.toContain("<a ");
    expect(table).not.toContain("<button");
    expect(f.productStateWords({ productStatus: "published", drifted: false })).toBe("Live");
    expect(f.productStateWords({ productStatus: "draft", drifted: false })).toBe("Not live (draft)");
    expect(f.productStateWords({ productStatus: null, drifted: false })).toBe("Not known");
  });

  it("Roster: required roles nobody fills first (Add party), then parties (End party), ended ones last", () => {
    const html = tab("roster");
    expect(html).toMatch(/data-toolbar[\s\S]*?Search your roster[\s\S]*?Export CSV[\s\S]*?data-add-party[\s\S]*?Add party/);
    expect([...html.matchAll(/data-roster-status="([a-z]+)"/g)].map((m) => m[1])).toEqual(["needed", "active", "ended"]);
    expect(html).toMatch(/Nobody yet[\s\S]*?AML compliance officer · fincen_msb[\s\S]*?Needed: nobody fills it[\s\S]*?data-fill-role[\s\S]*?Add party/);
    expect(html).toMatch(new RegExp(`Priya Shah[\\s\\S]*?qualified individual · state_mtl \\(us-ny\\)[\\s\\S]*?Active[\\s\\S]*?data-end-party="${PARTY}"[\\s\\S]*?End party`));
    expect(html).toMatch(/Audit LLP[\s\S]*?statutory audit[\s\S]*?Ended 2026-06-30/);
    expect(html.match(/data-end-party=/g)).toHaveLength(1);
  });

  it("People: licence providers, other members, those waiting (Decide) and those invited who haven't signed in", () => {
    const html = tab("people");
    expect([...html.matchAll(/data-person-status="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["licence_provider", "member", "waiting", "invited"]);
    expect(html).toMatch(/Lena[\s\S]*?Licence provider[\s\S]*?Omar[\s\S]*?Member[\s\S]*?cy@example\.com[\s\S]*?Waiting to be accepted[\s\S]*?Decide[\s\S]*?ivy@example\.com[\s\S]*?Invited, not yet signed in/);
    expect(html.match(/data-decide=/g)).toHaveLength(1);
    expect(f.peopleCsv(f.peopleOf(FIRM_RECORD, ONBOARDING)).split("\n")[4]).toBe(",ivy@example.com,\"Invited, not yet signed in\",2026-11-22");
  });

  it("Notices: read-only, each event in words, with plain details only", () => {
    const html = tab("notices");
    for (const h of ["When", "What", "Details", "Read"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain("Partner ledger: source changed");
    expect(html).toContain("source: sandbox · by: admin");
    expect(html).not.toContain("secret");
    expect(html).toContain("2026-11-20 09:30");
    expect(f.noticeWords("firm.member_added")).toBe("A member was added");
  });

  it("a tab whose data Mynt didn't give says so, never an empty table", () => {
    const html = renderToStaticMarkup(<FirmView data={{ ...DATA, licences: null }} notices={[]} />);
    expect(html).toContain("Mynt didn&#x27;t say which licences your firm holds just now.");
    expect(html).not.toContain("No licences yet");
  });
});

describe("the sheets, each posting to its route", () => {
  it("Set firm facts → /api/firm/facts with the typed identifiers, the firm's other ones kept; a malformed LEI isn't sent", async () => {
    const { f: fn, calls } = fetcher();
    render(<FirmView data={DATA} initialSheet={{ kind: "facts" }} notices={[]} fetcher={fn} />);
    expect(q("[data-facts-legal-name]")?.textContent).toBe("Legal name on Mynt: Partner Trust");
    expect(q("[data-facts-rule]")?.textContent).toMatch(/^The rule: a matching GLEIF LEI record or a matching FinCEN MSB registration/);
    expect(q("[data-facts-kept]")?.textContent).toBe("Kept as they are: us ein 12-3456789.");
    expect((q('[data-fact="lei"]') as HTMLInputElement).value).toBe(LEI);
    type('[data-fact="lei"]', "nope");
    await submit("[data-firm-facts-form]");
    expect(q("[data-sheet-error]")?.textContent).toBe("An LEI is 20 letters and digits, ending in two digits.");
    expect(calls).toEqual([]);
    type('[data-fact="lei"]', LEI.toLowerCase());
    type('[data-fact="us_fincen_msb"]', " 31000123 ");
    await submit("[data-firm-facts-form]");
    expect(calls).toEqual([
      { url: "/api/firm/facts", method: "POST", body: { identifiers: [{ scheme: "lei", value: LEI }, { scheme: "us_fincen_msb", value: "31000123" }, { scheme: "us_ein", value: "12-3456789" }] } },
    ]);
    expect(q("[data-sheet-result]")?.textContent).toBe("Done by Mynt.");
  });

  it("Register licence → /api/firm/licences: the type from the region's model, the state only where the type is issued per state, the dates", async () => {
    const { f: fn, calls } = fetcher();
    render(<FirmView data={DATA} initialSheet={{ kind: "licence" }} notices={[]} fetcher={fn} />);
    expect([...document.querySelectorAll("[data-licence-type] option")].map((o) => o.textContent)).toEqual(["Choose…", "US · FinCEN · MSB registration", "US · NYDFS · State licence"]);
    expect(q("[data-licence-jurisdiction]")).toBeNull();
    type("[data-licence-type]", "US/nydfs/state_mtl");
    expect([...document.querySelectorAll("[data-licence-jurisdiction] option")].map((o) => o.textContent)).toEqual(["Choose…", "US-NY", "US-CA"]);
    type("[data-licence-number]", "MT-103456");
    await submit("[data-register-licence-form]");
    expect(q("[data-sheet-error]")?.textContent).toBe("This licence type is issued per state: choose the one it was issued for.");
    expect(calls).toEqual([]);
    type("[data-licence-jurisdiction]", "us-ca");
    type("[data-licence-valid-from]", "2026-01-01");
    type("[data-licence-valid-to]", "2027-01-01");
    await submit("[data-register-licence-form]");
    expect(calls).toEqual([{ url: "/api/firm/licences", method: "POST", body: { region: "US", regulator_id: "nydfs", license_id: "state_mtl", jurisdiction: "us-ca", registration_number: "MT-103456", valid_from: "2026-01-01", valid_to: "2027-01-01" } }]);
    // A type that isn't issued per state takes no state.
    expect(licenceFormProblem({ typeKey: "x", jurisdiction: "", number: "1", validFrom: "", validTo: "" }, TYPES[0]!)).toBeNull();
    expect(licenceFormProblem({ typeKey: "x", jurisdiction: "", number: "1", validFrom: "2027-01-01", validTo: "2026-01-01" }, TYPES[0]!)).toBe("It can't end before it starts.");
    expect(licenceFormProblem({ typeKey: "", jurisdiction: "", number: "1", validFrom: "", validTo: "" }, null)).toBe("Choose the licence type.");
  });

  it("Review request warns before anyone tries when the real-company check hasn't passed: Approve is off, Decline still works", async () => {
    const { f: fn, calls } = fetcher();
    render(<FirmView data={DATA} initialTab="requests" notices={[]} fetcher={fn} />);
    await click(`[data-review="${REQ}"]`);
    expect(q("[data-review-check-warning]")?.textContent).toMatch(/^You can't approve yet\. Real-company check: Not passed\./);
    expect((q("[data-review-approve]") as HTMLButtonElement).disabled).toBe(true);
    await click("[data-review-decline]");
    expect(q("[data-sheet-error]")?.textContent).toBe("Say why you decline (3 characters or more).");
    type("[data-review-note]", "Outside our programme");
    await click("[data-review-decline]");
    expect(calls).toEqual([{ url: `/api/firm/sponsorships/${REQ}`, method: "POST", body: { action: "decline", reason: "Outside our programme" } }]);
  });

  it("Review request → Approve sponsorship under the licences in force, where chosen, once the check has passed", async () => {
    const { f: fn, calls } = fetcher();
    const passed = { ...DATA, onboarding: f.fromOnboarding(reply({}, { passes: true }))! };
    render(<FirmView data={passed} initialSheet={{ kind: "review", request: REQUESTS[0]! }} notices={[]} fetcher={fn} />);
    expect(q("[data-review-check-warning]")).toBeNull();
    expect(q(`[data-review-request="${REQ}"]`)?.textContent).toContain("Dollar Send");
    expect(q(`[data-review-request="${REQ}"]`)?.textContent).toContain("Their note: Launching in March");
    // Only a licence verified and in force can be named: the one still waiting is shown, and can't be ticked.
    expect((q(`[data-review-licence="${LIC}"]`) as HTMLInputElement).checked).toBe(true);
    expect((q(`[data-review-licence="${LIC2}"]`) as HTMLInputElement).disabled).toBe(true);
    await act(async () => void fireEvent.click(q('[data-review-jurisdiction="us-ca"]')!));
    type("[data-review-note]", "Welcome aboard");
    await click("[data-review-approve]");
    expect(calls).toEqual([{ url: `/api/firm/sponsorships/${REQ}`, method: "POST", body: { action: "approve", licence_ids: [LIC], jurisdictions: ["us-ny"], note: "Welcome aboard" } }]);
  });

  it("shows Mynt's refusal in its own words", async () => {
    const { f: fn } = fetcher({ error: "mynt_refused", message: "licence 'x' (fincen_msb) covers nowhere by itself" }, 422);
    const passed = { ...DATA, onboarding: f.fromOnboarding(reply({}, { passes: true }))! };
    render(<FirmView data={passed} initialSheet={{ kind: "review", request: REQUESTS[0]! }} notices={[]} fetcher={fn} />);
    await click("[data-review-approve]");
    expect(q("[data-sheet-error]")?.textContent).toBe("licence 'x' (fincen_msb) covers nowhere by itself");
  });

  it("Revoke sponsorship → its route with the reason", async () => {
    const { f: fn, calls } = fetcher();
    render(<FirmView data={DATA} initialTab="requests" notices={[]} fetcher={fn} />);
    await click(`[data-revoke="${SPON}"]`);
    expect((q("[data-revoke-submit]") as HTMLButtonElement).disabled).toBe(true);
    type("[data-revoke-reason]", "Covenant breach");
    await submit("[data-revoke-form]");
    expect(calls).toEqual([{ url: `/api/firm/sponsorships/${SPON}`, method: "POST", body: { action: "revoke", reason: "Covenant breach" } }]);
  });

  it("Add party → /api/firm/parties: a needed role's row opens it with that role ticked; End party → its route", async () => {
    const { f: fn, calls } = fetcher();
    render(<FirmView data={DATA} initialTab="roster" notices={[]} fetcher={fn} />);
    await click("[data-fill-role]");
    const fill = `${LIC}|fincen_aml_compliance_officer`;
    expect((q(`[data-party-fill="${fill}"]`) as HTMLInputElement).checked).toBe(true);
    await submit("[data-add-party-form]");
    expect(q("[data-sheet-error]")?.textContent).toBe("Give the person's name.");
    type("[data-party-name]", "Asha Verma");
    type("[data-party-since]", "2026-11-01");
    await submit("[data-add-party-form]");
    expect(calls).toEqual([{ url: "/api/firm/parties", method: "POST", body: { kind: "internal", person: { name: "Asha Verma" }, fills: [{ licence_id: LIC, stakeholder: "fincen_aml_compliance_officer" }], since: "2026-11-01" } }]);
    cleanup();
    const second = fetcher();
    render(<FirmView data={DATA} initialTab="roster" notices={[]} fetcher={second.f} />);
    await click(`[data-end-party="${PARTY}"]`);
    type("[data-end-party-until]", "2026-12-01");
    await submit("[data-end-party-form]");
    expect(second.calls).toEqual([{ url: `/api/firm/parties/${PARTY}`, method: "POST", body: { until: "2026-12-01" } }]);
    // Another firm: by its legal name, or its id on Mynt, never both.
    const form = { kind: "external" as const, name: "Audit LLP", entityId: "", fills: [], relationship: "statutory_audit", since: "" };
    expect(partyFormProblem(form)).toBeNull();
    expect(partyFormProblem({ ...form, entityId: FIRM })).toBe("Give the other firm's legal name or its firm id, not both.");
    expect(partyFormProblem({ ...form, name: "", entityId: "nope" })).toBe("A firm id looks like 123e4567-e89b-42d3-a456-426614174000.");
    expect(partyFormProblem({ ...form, relationship: "Statutory Audit" })).toMatch(/lowercase code/);
  });

  it("Decide → the member request's route, to accept or decline", async () => {
    const { f: fn, calls } = fetcher();
    render(<FirmView data={DATA} initialTab="people" notices={[]} fetcher={fn} />);
    await click(`[data-decide="${MEMBER}"]`);
    expect(q(`[data-decide-member="${MEMBER}"]`)?.textContent).toContain("cy@example.com · waiting since 2026-11-20");
    await click("[data-decide-accept]");
    expect(calls).toEqual([{ url: `/api/firm/members/${MEMBER}`, method: "POST", body: { accept: true } }]);
  });

  it("reads the firm again once a sheet that changed something closes", async () => {
    const { f: fn } = fetcher();
    const changed = vi.fn();
    render(<FirmView data={DATA} initialSheet={{ kind: "facts" }} notices={[]} fetcher={fn} onChanged={changed} />);
    await submit("[data-firm-facts-form]");
    expect(changed).not.toHaveBeenCalled();
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
