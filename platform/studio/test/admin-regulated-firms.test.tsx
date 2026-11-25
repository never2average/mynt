// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// Platform admin → Regulated firms: the list's Onboarding column, and on a firm's page the real-company check in the
// metadata card (latest result, when, the rule, what's missing), Run checks, and the Onboarding and Checks tabs.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/firms",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { FirmsListView, FirmDetailView, FIRM_DETAIL_TABS, checkResultWords, checkMissingWords } = await import("@/components/admin-firms");
const admin = await import("@/lib/admin");
const firmArea = await import("@/lib/firm-area");

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
const FIRM_ROW: import("@/lib/admin").Firm = {
  id: FIRM,
  name: "Acme Trust",
  status: "active",
  legalForm: "company_private",
  country: "us",
  regions: ["US"],
  members: [{ id: "u1", name: "Lee", email: "lee@example.com", roles: ["license_provider"] }],
  licences: [],
  awaitingReview: 0,
  types: ["license_provider"],
  createdAt: "2026-10-01T00:00:00.000Z",
};
const RULE = "a matching GLEIF LEI record or a matching FinCEN MSB registration, and no mismatch or lapse";
const onboardingOf = (check: Record<string, unknown> = {}, status = "blocked") =>
  firmArea.fromOnboarding({
    entity: { id: FIRM, name: "Acme Trust", status: "active" },
    steps: [
      { key: "firm_registered", title: "Your firm is registered with Mynt", status: "done", detail: "Acme Trust is registered with Mynt and active.", tool: "register_firm", by: "admin", informational: false, facts: {} },
      { key: "firm_facts", title: "Firm facts for the real-company check", status: "next", detail: "Record its LEI.", tool: "set_entity_facts", by: "firm", informational: false, facts: {} },
      {
        key: "real_company_check",
        title: "Real-company check passed",
        status,
        detail: "Not passed. GLEIF's LEI record: not found (2026-11-20).",
        tool: "run_firm_checks",
        by: "admin",
        informational: false,
        facts: { rule: "lei_or_msb", rule_text: RULE, passes: false, reasons: ["gleif_lei: not_found (No LEI record)", "fincen_msb: not_found"], last_run_at: "2026-11-20T10:00:00.000Z", last_answer_at: "2026-11-20T10:00:00.000Z", ...check },
      },
      { key: "first_sponsorship", title: "First sponsorship approved", status: "not_started", detail: "No requests yet.", tool: "request_sponsorship", by: "builder", informational: true, facts: {} },
    ],
    progress: { done: 1, total: 7, next: { key: "firm_facts", title: "Firm facts for the real-company check", status: "next" }, complete: false },
    ready_to_sponsor: false,
    checks: [
      { id: "c2", source: "fincen_msb", source_name: "FinCEN's MSB registrant list", status: "unavailable", status_words: "couldn't be reached", at: "2026-11-21T08:00:00.000Z", note: "HTTP 502", scheduled: true },
      { id: "c1", source: "gleif_lei", source_name: "GLEIF's LEI record", status: "not_found", status_words: "not found", at: "2026-11-20T10:00:00.000Z", note: null, scheduled: false },
    ],
  })!;
const detail = (check: Record<string, unknown> = {}, status = "blocked") => ({ firm: FIRM_ROW, offerings: null, products: null, onboarding: onboardingOf(check, status) });

describe("the Regulated firms list's Onboarding column", () => {
  it("says how far each regulated firm is and its next step; why there's none otherwise; never 0 for a count Mynt didn't give", () => {
    const row = (onboarding: import("@/lib/admin").Firm["onboarding"]) => ({ ...FIRM_ROW, id: `f${Math.random()}`, ...(onboarding === undefined ? {} : { onboarding }) });
    const base = { entityId: FIRM, checkPasses: false, readyToSponsor: false };
    const html = renderToStaticMarkup(
      <FirmsListView
        firms={[
          row({ ...base, done: 5, total: 7, complete: false, next: { title: "Roster filled for your licences", waiting: false } }),
          row({ ...base, done: 3, total: 7, complete: false, next: { title: "Real-company check passed", waiting: true } }),
          row({ ...base, done: 7, total: 7, complete: true, next: null }),
          row({ ...base, done: null, total: null, complete: false, next: null }),
          row(null),
          row(undefined),
        ]}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain(">Onboarding</th>");
    expect([...html.matchAll(/data-firm-onboarding="[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      "5 of 7 steps done · Next: Roster filled for your licences",
      "3 of 7 steps done · Next: Real-company check passed (waiting)",
      "All 7 steps done",
      "Not known",
      "Not a licence provider",
      "Not available",
    ]);
    expect(admin.regulatedFirmsFrom({ firms: [{ entity_id: FIRM, progress: {}, real_company_check: { passes: null } }] })).toEqual([{ entityId: FIRM, done: null, total: null, complete: false, next: null, checkPasses: null, readyToSponsor: false }]);
    expect(admin.regulatedFirmsFrom({ ok: true })).toBeNull();
  });
});

describe("a regulated firm's page: the real-company check", () => {
  it("shows the latest result, when, the rule and what's missing in the metadata card, with a labelled Run checks", () => {
    const html = renderToStaticMarkup(<FirmDetailView detail={detail()} onBack={() => undefined} />);
    const card = html.slice(html.indexOf("data-metadata-card"), html.indexOf('role="tablist"'));
    expect(card).toMatch(/Real-company check<\/dt><dd[^>]*><span data-real-company-check="not_passed">Not passed<\/span>/);
    expect(card).toMatch(/Last checked<\/dt><dd[^>]*>[^<]*2026/);
    expect(card).toContain(RULE);
    expect(card).toContain("gleif_lei: not_found (No LEI record); fincen_msb: not_found");
    expect(card).toMatch(/data-run-checks[^>]*>[\s\S]*?<\/svg>Run checks<\/button>/);
    expect(FIRM_DETAIL_TABS).toEqual(["members", "licences", "offerings", "products", "onboarding", "checks"]);
    for (const t of ["Onboarding", "Checks"]) expect(html).toMatch(new RegExp(`data-detail-tab="${t.toLowerCase()}"[^>]*>${t}<`));
  });

  it("says each result in words, and never a pass Mynt didn't measure", () => {
    const check = (over: Record<string, unknown>, status = "blocked") => onboardingOf(over, status).check;
    expect(checkResultWords(check({ passes: true }, "done"))).toBe("Passed");
    expect(checkMissingWords(check({ passes: true }, "done"))).toBe("Nothing");
    expect(checkResultWords(check({ last_run_at: null, last_answer_at: null }))).toBe("Not run yet");
    expect(checkResultWords(check({ last_answer_at: null }))).toBe("Not known: the registers couldn't be reached");
    expect(checkResultWords(check({ passes: null }, "done"))).toBe("Not required on this Mynt");
    expect(checkResultWords(null)).toBe("Not available");
    expect(checkMissingWords(null)).toBe("Not available");
    expect(checkMissingWords(check({ reasons: [] }))).toBe("Mynt didn't say");
    // A Mynt without the checklist: the card says the check isn't available, the tabs say so too.
    const older = renderToStaticMarkup(<FirmDetailView detail={{ firm: FIRM_ROW, offerings: null, products: null }} onBack={() => undefined} initialTab="checks" />);
    expect(older).toContain('data-real-company-check="unknown">Not available<');
    expect(older).toMatch(/>Register<\/th>[\s\S]*?data-not-available[\s\S]*?Not available\. The registers&#x27; answers come with Mynt&#x27;s next update\./);
  });

  it("Run checks opens a sheet that posts to the firm's checks route and shows Mynt's answer", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, passes: true, message: "GLEIF's LEI record: matches. The firm passes the real-company check." }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    let changed = 0;
    render(<FirmDetailView detail={detail()} onBack={() => undefined} onChanged={() => void changed++} fetcher={f} />);
    await act(async () => void fireEvent.click(document.querySelector("[data-run-checks]")!));
    expect(document.querySelector('[data-admin-sheet="run-checks"]')).not.toBeNull();
    expect(document.querySelector("[data-run-checks-rule]")?.textContent).toBe(`The rule: ${RULE}.`);
    await act(async () => void fireEvent.click(document.querySelector("[data-run-checks-submit]")!));
    expect(calls).toEqual([{ url: `/api/admin/firms/${FIRM}/checks`, body: {} }]);
    expect(document.querySelector("[data-sheet-result]")?.textContent).toBe("GLEIF's LEI record: matches. The firm passes the real-company check.");
    expect(document.querySelector("[data-run-checks-submit]")?.textContent).toBe("Run checks again");
    expect(changed).toBe(0);
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(changed).toBe(1); // the firm is read again once the sheet closes
  });

  it("the Checks tab lists past answers, newest first, each in words; the Onboarding tab lists the steps", () => {
    const checks = renderToStaticMarkup(<FirmDetailView detail={detail()} onBack={() => undefined} initialTab="checks" />);
    for (const h of ["When", "Register", "Result", "Note", "Run"]) expect(checks).toContain(`>${h}</th>`);
    expect([...checks.matchAll(/data-check-result="([a-z_]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])).toEqual([["unavailable", "Couldn&#x27;t be reached"], ["not_found", "Not found"]]);
    expect(checks).toMatch(/2026-11-21 08:00[\s\S]*?FinCEN&#x27;s MSB registrant list[\s\S]*?HTTP 502[\s\S]*?Mynt&#x27;s monthly re-check[\s\S]*?2026-11-20 10:00[\s\S]*?GLEIF&#x27;s LEI record[\s\S]*?By an admin/);
    const none = renderToStaticMarkup(<FirmDetailView detail={{ ...detail(), onboarding: { ...onboardingOf(), checks: [] } }} onBack={() => undefined} initialTab="checks" />);
    expect(none).toContain("No register has been asked about this firm yet. Run checks.");
    const steps = renderToStaticMarkup(<FirmDetailView detail={detail()} onBack={() => undefined} initialTab="onboarding" />);
    for (const h of ["Step", "Status", "Where it stands", "Done by"]) expect(steps).toContain(`>${h}</th>`);
    expect([...steps.matchAll(/data-step-status="([a-z_]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])).toEqual([["done", "Done"], ["next", "Do this next"], ["blocked", "Waiting"], ["not_started", "Not started"]]);
    expect(steps).toContain("First sponsorship approved (for information)");
    expect(steps).toMatch(/Record its LEI\.[\s\S]*?The firm[\s\S]*?Not passed\. GLEIF&#x27;s LEI record: not found \(2026-11-20\)\.[\s\S]*?Mynt[\s\S]*?Builders/);
  });
});
