// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRef } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to}` });
  },
}));

const { PromotionView, StageControl, MoveBackForm } = await import("@/components/promotion-view");
const { AppTopBar } = await import("@/components/app-top-bar");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { WorkspaceView, WorkspaceCard, SettingsTab, NO_SETTINGS_TOOLS } = await import("@/components/workspace-view");
const { NeedsAttention, AppsByStage, RecentActivity } = await import("@/components/dashboard-panels");
const { DashboardView } = await import("@/components/dashboard-view");
const { TeamSwitcher } = await import("@/components/team-switcher");
const { fromPromotionChecks, readinessOf, readinessText, nextStage, earlierStages } = await import("@/lib/promotions");
const { fromAttention } = await import("@/lib/attention");
const { fromAudit } = await import("@/lib/compliance");
const { fromDashboardTool } = await import("@/lib/dashboard");
const { tabOf } = await import("@/lib/workspace-tabs");
const { pageTitle, isAppPath, searchIndex } = await import("@/lib/studio-search");

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

const reply = {
  app_id: "a1",
  from_stage: "staging",
  to_stage: "production",
  checks: [
    { id: "build", label: "Latest build verified", status: "pass", detail: "Build b9 passed", fix: { label: "should be dropped", href: "/a1" } },
    { id: "terms", label: "Product terms", status: "fail", detail: "Missing a required disclosure", fix: { label: "Open the app", href: "/a1" } },
    { id: "keys", label: "Webhook signing", status: "warn", detail: "No webhook yet", fix: { label: "Read the guide", href: "https://docs.example.test/webhooks" } },
    { id: "evil", label: "Bad link", status: "pending", fix: { label: "Click", href: "javascript:alert(1)" } },
    { id: "tool", label: "Rotate key", status: "fail", fix: { label: "Rotate the app key", tool: "rotate_api_key" } },
  ],
  can_promote: false,
  needs_admin_signoff: true,
  signoff: { status: "none" },
};
const checks = fromPromotionChecks(reply, "production")!;
const passing = fromPromotionChecks({ ...reply, checks: [reply.checks[0]], can_promote: true, needs_admin_signoff: false }, "production")!;
const noop = () => undefined;

describe("promotion checks", () => {
  it("read each check, keep only studio or https fixes, and never call a failing app promotable", () => {
    expect(checks.checks.map((c) => [c.id, c.status])).toEqual([["build", "pass"], ["terms", "fail"], ["keys", "warn"], ["evil", "pending"], ["tool", "fail"]]);
    expect(checks.checks[0].fix).toBeNull(); // a passing check has nothing to fix
    expect(checks.checks[1].fix).toMatchObject({ href: "/a1", external: false });
    expect(checks.checks[2].fix).toMatchObject({ href: "https://docs.example.test/webhooks", external: true });
    expect(checks.checks[3].fix).toBeNull(); // javascript: dropped
    expect(checks.checks[4].fix).toMatchObject({ href: null, tool: "rotate_api_key" });
    expect(fromPromotionChecks({ ...reply, can_promote: true }, "production")!.canPromote).toBe(false);
    expect(fromPromotionChecks("nope", "staging")).toBeNull();
  });

  it("go one stage at a time, and back only to earlier stages", () => {
    expect([nextStage("idea"), nextStage("staging"), nextStage("production")]).toEqual(["staging", "production", null]);
    expect([earlierStages("production"), earlierStages("staging"), earlierStages("idea")]).toEqual([["staging", "idea"], ["idea"], []]);
  });

  it("render each check with a red, amber or green status in words, its detail and its fix", () => {
    const html = renderToStaticMarkup(<PromotionView appName="Cards" checks={checks} canChange signoffSupported onPromote={noop} onRequestSignoff={noop} />);
    expect(html).toContain('data-check="terms" data-status="fail"');
    expect(html).toMatch(/data-tone="red"[\s\S]*?Failing/);
    expect(html).toMatch(/data-tone="amber"[\s\S]*?Warning/);
    expect(html).toMatch(/data-tone="green"[\s\S]*?Passed/);
    expect(html).toContain("Missing a required disclosure");
    expect(html).toContain('href="/a1"');
    expect(html).toMatch(/href="https:\/\/docs\.example\.test\/webhooks" target="_blank" rel="noopener noreferrer"/);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("To fix: Rotate the app key");
  });

  it("disable Promote unless Mynt says the app can move", () => {
    render(<PromotionView appName="Cards" checks={checks} canChange signoffSupported onPromote={noop} onRequestSignoff={noop} />);
    expect((screen.getByRole("button", { name: "Promote to Production" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("2 checks must pass first.")).toBeTruthy();
    cleanup();
    const promoted: string[] = [];
    render(<PromotionView appName="Cards" checks={passing} canChange signoffSupported onPromote={() => promoted.push("go")} onRequestSignoff={noop} />);
    const button = screen.getByRole("button", { name: "Promote to Production" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(promoted).toEqual(["go"]);
  });

  it("show the admin sign-off: a Request button until it's asked for, then its status", () => {
    const asked: string[] = [];
    render(<PromotionView appName="Cards" checks={checks} canChange signoffSupported onPromote={noop} onRequestSignoff={() => asked.push("x")} />);
    expect(screen.getByText(/needs a Mynt admin's sign-off\. Not requested yet\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request admin sign-off" }));
    expect(asked).toEqual(["x"]);
    cleanup();
    const requested = { ...checks, signoff: { status: "requested" as const, by: null, at: null } };
    render(<PromotionView appName="Cards" checks={requested} canChange signoffSupported onPromote={noop} onRequestSignoff={noop} />);
    expect(screen.getByText(/Requested\. A Mynt admin reviews it\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request admin sign-off" })).toBeNull();
    cleanup();
    // Not offered by this Mynt: the status shows, the button doesn't.
    render(<PromotionView appName="Cards" checks={checks} canChange signoffSupported={false} onPromote={noop} onRequestSignoff={noop} />);
    expect(screen.queryByRole("button", { name: "Request admin sign-off" })).toBeNull();
  });

  it("let members see the checks, but not promote or request sign-off", () => {
    render(<PromotionView appName="Cards" checks={passing} canChange={false} signoffSupported onPromote={noop} onRequestSignoff={noop} />);
    expect(screen.getByText("Latest build verified")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Promote to Production" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Only the workspace's owners and admins promote apps/)).toBeTruthy();
    cleanup();
    render(<PromotionView appName="Cards" checks={checks} canChange={false} signoffSupported onPromote={noop} onRequestSignoff={noop} />);
    expect(screen.queryByRole("button", { name: "Request admin sign-off" })).toBeNull();
  });

  it("move back only to an earlier stage, with a reason", () => {
    const moved: [string, string][] = [];
    render(<MoveBackForm appName="Cards" stage="production" onMoveBack={(to, why) => moved.push([to, why])} />);
    const submit = screen.getByRole("button", { name: "Move back to Staging" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Partner paused the product" } });
    fireEvent.click(submit);
    expect(moved).toEqual([["staging", "Partner paused the product"]]);
    expect([...(screen.getByLabelText("Move back to") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["staging", "idea"]);
  });
});

// The app top bar's stage control, against a stubbed studio API.
function stubPromotionApi(meta: unknown, checksReply: unknown = { checks }) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = init?.method === "POST" ? { ok: true, message: "Cards is now in Production." } : url.includes("?to=") ? { ...(meta as object), ...(checksReply as object) } : meta;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}
const meta = (canChange: boolean, demote = true) => ({ supported: true, app: { id: "a1", name: "Cards", stage: "staging" }, canChange, tools: { demote, signoff: true } });
const topBar = (stage: "idea" | "staging" | "production" = "staging") => (
  <TooltipProvider>
    <SidebarProvider>
      <AppTopBar appId="a1" appName="Cards" stage={stage} backLabel="All apps" onBack={noop} previewUrl={null} iframeRef={createRef()} device="desktop" onDevice={noop} />
    </SidebarProvider>
  </TooltipProvider>
);

describe("the app top bar's stage control", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("is a quiet note, not a control, until Mynt has promotions", async () => {
    stubPromotionApi({ supported: false });
    const { container } = render(topBar());
    await act(async () => undefined);
    expect(container.querySelector('[data-promotion="unavailable"]')?.textContent).toMatch(/not available yet|aren't available yet/);
    expect(screen.queryByRole("button", { name: /Promote to/ })).toBeNull();
  });

  it("offers the next stage only, and Move back to owners and admins", async () => {
    stubPromotionApi(meta(true));
    render(topBar("staging"));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Promote to Production" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Promote to Staging" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move back" })).toBeTruthy();
    cleanup();
    stubPromotionApi(meta(true));
    render(topBar("idea"));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Promote to Staging" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move back" })).toBeNull(); // nothing earlier than Ideas
    cleanup();
    stubPromotionApi(meta(true));
    render(topBar("production"));
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: /Promote to/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Move back" })).toBeTruthy();
  });

  it("lets members open the checks, but never Move back", async () => {
    stubPromotionApi(meta(false));
    render(topBar("staging"));
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Move back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Promote to Production" }));
    await act(async () => undefined);
    expect(screen.getByText("Product terms")).toBeTruthy();
    expect(screen.getByText(/Only the workspace's owners and admins promote apps/)).toBeTruthy();
  });

  it("opens the checks, promotes when they pass, shows the result and refreshes the sidebar's folders", async () => {
    const calls = stubPromotionApi(meta(true), { checks: passing });
    const refreshed: string[] = [];
    const listen = () => refreshed.push("projects");
    window.addEventListener("adorable:projects-updated", listen);
    render(topBar("staging"));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Promote to Production" }));
    await act(async () => undefined);
    expect(calls.some((c) => c.url === "/api/apps/a1/promotion?to=production")).toBe(true);
    const promote = screen.getAllByRole("button", { name: "Promote to Production" }).find((b) => b.hasAttribute("data-promote"))!;
    fireEvent.click(promote);
    await act(async () => undefined);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "promote", to_stage: "production" });
    expect(screen.getByText("Cards is now in Production.")).toBeTruthy();
    expect(refreshed).toEqual(["projects"]);
    window.removeEventListener("adorable:projects-updated", listen);
  });
});

const ws = { id: "w1", name: "Acme", role: "owner" as const, createdAt: "2026-09-01T00:00:00Z", memberCount: 3 };
const info = { supported: true, workspace: ws, canManage: true, isOwner: true, tools: { ...NO_SETTINGS_TOOLS, rename: true } };
const membersData = { supported: true, canManage: true, members: [{ userId: "u1", name: "Ines", email: "ines@example.com", role: "owner" as const }], invites: [], manageUrl: "https://accounts.example.test/organization" };
const appsRows = [
  { id: "a1", name: "Cards", stage: "production" as const, owner: "Ines", lastBuild: { id: "b1", status: "succeeded", at: "2026-11-10T00:00:00Z" } },
  { id: "a2", name: "Budgeting", stage: "idea" as const, owner: null, lastBuild: null },
];
const actions = { invite: async () => null, changeRole: async () => null, remove: async () => null, revoke: async () => null };
const settings = { rename: async () => null, archive: async () => null, unarchive: async () => null, relink: async () => null };

describe("the Workspace page", () => {
  it("has a details card on top: name, your role, created, members, apps by stage and Manage in Clerk", () => {
    const html = renderToStaticMarkup(<WorkspaceCard info={info} members={membersData} apps={appsRows} />);
    for (const s of ["Workspace name", "Your role", "Created", "Sep 1, 2026", "Members", "Apps by stage", "Production 1", "Staging 0", "Ideas 1"]) expect(html).toContain(s);
    expect(html).toMatch(/href="https:\/\/accounts\.example\.test\/organization"[^>]*>Manage in Clerk/);
    // No manage_url from Mynt: no link.
    expect(renderToStaticMarkup(<WorkspaceCard info={info} members={{ ...membersData, manageUrl: null }} apps={appsRows} />)).not.toContain("Manage in Clerk");
    // Not recorded by Mynt: said so, never made up.
    expect(renderToStaticMarkup(<WorkspaceCard info={{ ...info, workspace: { id: "w1", name: "Acme", role: "owner" } }} members={null} apps={null} />)).toContain("Not recorded");
  });

  it("has Members, Invitations, Apps and Settings tabs, from ?tab=", () => {
    expect([tabOf("members"), tabOf("invitations"), tabOf("apps"), tabOf("settings"), tabOf("nope"), tabOf(undefined)]).toEqual(["members", "invitations", "apps", "settings", "members", "members"]);
    const view = (tab: "members" | "invitations" | "apps" | "settings") =>
      renderToStaticMarkup(<WorkspaceView tab={tab} onTab={noop} info={info} members={membersData} apps={appsRows} memberActions={actions} settingsActions={settings} />);
    const html = view("apps");
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)" data-tab="(\w+)"/g)].map((m) => [m[2], m[1]]);
    expect(tabs).toEqual([["members", "false"], ["invitations", "false"], ["apps", "true"], ["repositories", "false"], ["settings", "false"]]);
    expect(html).toContain('data-tab-panel="apps"');
    expect(html).toContain('href="/a1/b1"');
    expect(html).toContain(">Open app<");
    expect(html).toContain("Not shown by Mynt"); // an owner Mynt doesn't name
    expect(html).toMatch(/>\s*New app\s*</);
    expect(view("members")).toContain('data-tab-panel="members"');
    expect(view("invitations")).toContain('data-tab-panel="invitations"');
    expect(view("settings")).toContain("data-rename-form");
  });

  it("shows archive controls only to owners, and only where Mynt has the tools", () => {
    const html = (i: typeof info) => renderToStaticMarkup(<SettingsTab info={i} actions={settings} />);
    expect(html(info)).not.toContain("data-owner-settings"); // this Mynt has no archive tools yet
    const withTools = { ...info, tools: { rename: true, archive: true, unarchive: true, relink: true } };
    expect(html(withTools)).toContain(">Archive workspace<");
    expect(html({ ...withTools, isOwner: false })).not.toContain("data-owner-settings");
    const archived = { ...withTools, workspace: { ...ws, archivedAt: "2026-11-10T00:00:00Z", offboardingAt: "2026-11-17T00:00:00Z" } };
    expect(html(archived)).toContain(">Unarchive workspace<");
    expect(html(archived)).not.toContain(">Archive workspace<");
    const frozen = { ...withTools, workspace: { ...ws, orgMissingSince: "2026-11-09T00:00:00Z" } };
    expect(html(frozen)).toContain(">Give it a new organization<");
    // Members can't rename.
    expect(html({ ...info, canManage: false, isOwner: false })).toContain("Only the workspace&#x27;s owners and admins can rename it.");
  });

  it("is in the header's titles and search, and /members is still a page (it redirects), not an app", () => {
    expect(pageTitle("/workspace")).toBe("Workspace");
    expect(isAppPath("/members")).toBe(false);
    const index = searchIndex({ members: [{ userId: "u1", name: "Ines", email: "ines@example.com", role: "owner" }] });
    expect(index.find((i) => i.id === "member:u1")?.href).toBe("/workspace?tab=members");
    expect(index.some((i) => i.href === "/members")).toBe(false);
  });

  it("is no longer in the switcher's menu, which keeps Create workspace", async () => {
    render(
      <TooltipProvider>
        <SidebarProvider>
          <TeamSwitcher workspaces={[ws]} selected={ws} supported onSelect={noop} onCreate={async () => null} />
        </SidebarProvider>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Switch workspace" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    await act(async () => undefined);
    expect(screen.getByText("Create workspace")).toBeTruthy();
    expect(screen.queryByText("Members")).toBeNull();
    expect(document.querySelector('a[href="/members"]')).toBeNull();
  });
});

describe("/members", () => {
  it("redirects to the Workspace page's Members tab", async () => {
    const { default: MembersPage } = await import("@/app/(studio)/members/page");
    let to: string | undefined;
    try {
      MembersPage();
    } catch (e) {
      to = (e as { digest?: string }).digest;
    }
    expect(to).toContain("/workspace?tab=members");
  });
});

const attention = fromAttention({
  items: [
    { id: "x1", kind: "licence", severity: "low", title: "Licence renews in 50 days", detail: "Harbor Bank, CA", href: "/licences", at: "2026-11-01T00:00:00Z" },
    { id: "x2", kind: "build", severity: "high", title: "Cards' build failed", detail: "Typecheck failed", href: "/a1", at: "2026-11-12T00:00:00Z" },
    { id: "x3", severity: "medium", title: "Bad link", href: "javascript:alert(1)" },
    { id: "x4", severity: "high" },
  ],
});
const dashboard = fromDashboardTool({ apps: [{ app_id: "a1", name: "Cards", status: "published" }] });

describe("the dashboard's lower cards", () => {
  it("Needs attention lists items, most severe first, with a severity dot, detail and link", () => {
    expect(attention.map((i) => i.id)).toEqual(["x2", "x3", "x1"]); // x4 has no title
    const html = renderToStaticMarkup(<NeedsAttention state={{ kind: "ready", data: attention }} />);
    expect(html).toMatch(/data-severity="high"[\s\S]*?data-tone="red"[\s\S]*?High/);
    expect(html).toContain("Typecheck failed");
    expect(html).toContain('href="/a1"');
    expect(html).not.toContain("javascript:");
  });

  it("Needs attention says nothing needs you, or that it isn't available yet, never an empty list", () => {
    expect(renderToStaticMarkup(<NeedsAttention state={{ kind: "ready", data: [] }} />)).toContain("Nothing needs you right now");
    const unsupported = renderToStaticMarkup(<NeedsAttention state={{ kind: "unsupported" }} />);
    expect(unsupported).toContain('data-empty="not-available"');
    expect(unsupported).toContain("isn&#x27;t available yet");
    expect(renderToStaticMarkup(<NeedsAttention state={{ kind: "unavailable", message: "This workspace's data comes with Mynt's next update." }} />)).toContain("next update");
  });

  it("Apps by stage counts each stage, links each app, and shows its readiness for the next stage", () => {
    const ready = readinessOf(passing);
    const blocked = readinessOf(checks);
    expect(readinessText(ready)).toBe("Ready for Production");
    expect(readinessText(blocked)).toBe("2 checks failing for Production");
    const data = {
      checks: true,
      apps: [
        { id: "a1", name: "Cards", stage: "production" as const, readiness: null },
        { id: "a2", name: "Budgeting", stage: "staging" as const, readiness: ready },
        { id: "a3", name: "Vault", stage: "staging" as const, readiness: blocked },
        { id: "a4", name: "Allowance", stage: "idea" as const, readiness: "not_checked" as const },
      ],
    };
    const html = renderToStaticMarkup(<AppsByStage state={{ kind: "ready", data }} />);
    expect(html).toMatch(/data-stage-count="production">1</);
    expect(html).toMatch(/data-stage-count="staging">2</);
    expect(html).toMatch(/data-stage-count="idea">1</);
    expect(html).toContain('href="/a2"');
    expect(html).toContain("Ready for Production");
    expect(html).toContain("2 checks failing for Production");
    expect(html).toContain("Not checked yet");
    expect(html).toContain("Live");
    // Before Mynt has promotion checks: the counts, and readiness says it isn't available.
    const before = renderToStaticMarkup(<AppsByStage state={{ kind: "ready", data: { checks: false, apps: data.apps.map((a) => ({ ...a, readiness: null })) } }} />);
    expect(before).toContain("Promotion checks aren&#x27;t available yet");
  });

  it("Recent activity shows the newest 10 audit entries and links to Audits", () => {
    const events = fromAudit({ events: Array.from({ length: 14 }, (_, i) => ({ at: `2026-11-${String(14 - i).padStart(2, "0")}T10:00:00Z`, actor: { name: "Ines" }, action: "app.created", target: { type: "app", name: `App ${i}` } })) }).events;
    const html = renderToStaticMarkup(<RecentActivity state={{ kind: "ready", data: events }} />);
    expect(html.match(/data-activity-row/g)).toHaveLength(10);
    expect(html).toContain('href="/audits"');
    expect(html).toContain("App 0");
    expect(html).not.toContain("App 10");
    expect(renderToStaticMarkup(<RecentActivity state={{ kind: "unsupported" }} />)).toContain('data-empty="not-available"');
  });

  it("all sit on the dashboard with the tiles and the money cards kept", () => {
    const html = renderToStaticMarkup(
      <DashboardView
        dashboard={dashboard}
        attention={{ kind: "ready", data: [] }}
        stages={{ kind: "ready", data: { checks: false, apps: [{ id: "a1", name: "Cards", stage: "production", readiness: null }] } }}
        activity={{ kind: "unsupported" }}
      />,
    );
    for (const card of ['data-card="attention"', 'data-card="apps-by-stage"', 'data-card="recent-activity"', 'data-tile="active-products"']) expect(html).toContain(card);
    expect(html).toContain("Money moved through your apps");
    expect(html).toContain("Nothing needs you right now");
  });
});
