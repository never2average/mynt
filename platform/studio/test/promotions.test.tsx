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
const { WorkspaceView, NO_SETTINGS_TOOLS } = await import("@/components/workspace-view");
const { allowedSettings, RenameWorkspaceSheet, ConfirmWorkspaceSheet } = await import("@/components/workspace-settings");
import type { WorkspaceInfo } from "@/components/workspace-view";
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

describe("the Settings page (once Workspace)", () => {
  it("has no details card: the page starts with the line tab bar", () => {
    const view = (tab: "apps", m: Parameters<typeof WorkspaceView>[0]["members"] = membersData) =>
      renderToStaticMarkup(<WorkspaceView tab={tab} onTab={noop} info={info} members={m} apps={appsRows} memberActions={actions} />);
    const html = view("apps");
    expect(html).not.toContain("data-workspace-card");
    expect(html).not.toContain('data-slot="card"');
    for (const gone of ["Workspace name", "Your role", "Apps by stage", "Manage organization"]) expect(html, gone).not.toContain(gone);
    // The tab bar comes first, in the shared line variant.
    expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf('data-tab-panel="apps"'));
    expect(html).toMatch(/role="tablist" aria-label="Settings" data-slot="tabs-list" data-variant="line"/);
  });

  it("has Members, Invitations, Apps and Repositories tabs, from ?tab=", () => {
    expect([tabOf("members"), tabOf("invitations"), tabOf("apps"), tabOf("repositories"), tabOf("nope"), tabOf(undefined)]).toEqual(["members", "invitations", "apps", "repositories", "members", "members"]);
    const view = (tab: "members" | "invitations" | "apps") =>
      renderToStaticMarkup(<WorkspaceView tab={tab} onTab={noop} info={info} members={membersData} apps={appsRows} memberActions={actions} />);
    const html = view("apps");
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)" data-tab="(\w+)"/g)].map((m) => [m[2], m[1]]);
    expect(tabs).toEqual([["members", "false"], ["invitations", "false"], ["apps", "true"], ["repositories", "false"]]);
    expect(html).toContain('role="tablist" aria-label="Settings"');
    expect(html).toContain('data-tab-panel="apps"');
    expect(html).toContain('href="/a1/b1"');
    expect(html).toContain(">Open app<");
    expect(html).toContain("Not shown by Mynt"); // an owner Mynt doesn't name
    expect(html).toMatch(/>\s*New app\s*</);
    expect(view("members")).toContain('data-tab-panel="members"');
    expect(view("invitations")).toContain('data-tab-panel="invitations"');
  });

  it("has no General tab; ?tab=general and the old ?tab=settings open the first tab", () => {
    for (const tab of ["members", "apps"] as const) {
      const html = renderToStaticMarkup(<WorkspaceView tab={tab} onTab={noop} info={info} members={membersData} apps={appsRows} memberActions={actions} />);
      expect(html).not.toContain(">General<");
      expect(html).not.toContain('data-tab="general"');
      expect(html).not.toContain('data-tab-panel="general"');
      expect(html).not.toContain("data-rename-form");
      expect(html).not.toContain("Manage organization");
    }
    expect(tabOf("general")).toBe("members");
    expect(tabOf("settings")).toBe("members");
    expect(tabOf(["general"][0])).toBe("members");
  });

  it("Apps: key figures by stage, then search, one Filters button (Stage), Export CSV and New app last; stage as a status dot in words", () => {
    const html = renderToStaticMarkup(<WorkspaceView tab="apps" onTab={noop} info={info} members={membersData} apps={appsRows} memberActions={actions} />);
    const figure = (key: string) => new RegExp(`data-kpi="${key}"[\\s\\S]*?data-measured="true">(\\d+)<`).exec(html)?.[1];
    expect([figure("apps"), figure("production"), figure("staging"), figure("ideas")]).toEqual(["2", "1", "0", "1"]);
    const toolbar = ['aria-label="Search apps by name, stage or owner"', "data-filters-menu-button", ">Export CSV<", 'href="/new"'].map((s) => html.indexOf(s));
    expect(html).not.toContain('data-filter="Stage"');
    expect(toolbar.every((i) => i > 0)).toBe(true);
    expect([...toolbar].sort((a, b) => a - b)).toEqual(toolbar);
    const row = /data-app-row="a1"[\s\S]*?<\/tr>/.exec(html)![0];
    expect(row).toMatch(/data-tone="green"[\s\S]*?Production/);
    expect(row).not.toContain('data-slot="badge"');
    // Still loading: a Skeleton, never figures of 0.
    const loading = renderToStaticMarkup(<WorkspaceView tab="apps" onTab={noop} info={info} members={membersData} apps={null} memberActions={actions} />);
    expect(loading).not.toContain("data-kpi=");
    expect(loading).toContain('data-slot="skeleton"');
    expect(loading).not.toContain("rounded-xl");
  });

  it("Members: a member's role changes from its dropdown, not a native select", async () => {
    const changed: [string, string][] = [];
    const data = { ...membersData, members: [...membersData.members, { userId: "u2", name: "Sam", email: "sam@example.com", role: "member" as const }] };
    render(<WorkspaceView tab="members" onTab={noop} info={info} members={data} apps={appsRows} memberActions={{ ...actions, changeRole: async (u: string, r: string) => (changed.push([u, r]), null) }} />);
    expect(document.querySelector("select")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Role for sam@example.com" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Admin" }));
    await act(async () => undefined);
    expect(changed).toEqual([["u2", "admin"]]);
  });

  it("is in the header's titles and search, and /members is still a page (it redirects), not an app", () => {
    expect(pageTitle("/settings")).toBe("Settings");
    expect(pageTitle("/workspace")).toBe("Settings");
    expect(isAppPath("/workspace")).toBe(false);
    expect(isAppPath("/members")).toBe(false);
    const index = searchIndex({ members: [{ userId: "u1", name: "Ines", email: "ines@example.com", role: "owner" }] });
    expect(index.find((i) => i.id === "member:u1")?.href).toBe("/settings?tab=members");
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

describe("the workspace's settings, in the switcher's menu", () => {
  const all = { rename: true, archive: true, unarchive: true, relink: true };
  const owner = { ...info, tools: all };
  const admin = { ...owner, workspace: { ...ws, role: "admin" as const }, isOwner: false };
  const member = { ...owner, workspace: { ...ws, role: "member" as const }, isOwner: false, canManage: false };

  it("are allowed as General allowed them: rename for owners and admins, archive and unarchive for owners, only where Mynt has the tools", () => {
    expect(allowedSettings(owner)).toEqual(["rename", "archive"]);
    expect(allowedSettings(admin)).toEqual(["rename"]);
    expect(allowedSettings(member)).toEqual([]);
    expect(allowedSettings(null)).toEqual([]);
    expect(allowedSettings({ ...owner, supported: false })).toEqual([]);
    expect(allowedSettings({ ...owner, tools: NO_SETTINGS_TOOLS })).toEqual([]);
    expect(allowedSettings({ ...owner, workspace: { ...ws, personal: true } })).toEqual(["rename"]);
    expect(allowedSettings({ ...owner, workspace: { ...ws, archivedAt: "2026-11-10T00:00:00Z" } })).toEqual(["rename", "unarchive"]);
    expect(allowedSettings({ ...owner, workspace: { ...ws, orgMissingSince: "2026-11-09T00:00:00Z" } })).toEqual(["rename", "archive", "relink"]);
  });

  const openMenu = async (i: WorkspaceInfo | null) => {
    render(
      <TooltipProvider>
        <SidebarProvider>
          <TeamSwitcher workspaces={[i?.workspace ?? ws]} selected={i?.workspace ?? ws} supported onSelect={noop} onCreate={async () => null} settings={{ info: i, actions: settings }} />
        </SidebarProvider>
      </TooltipProvider>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Switch workspace" }), { key: "Enter" });
    await act(async () => undefined);
    return screen.getAllByRole("menuitem").map((m) => m.textContent?.trim());
  };

  it("shows Rename workspace and Archive workspace to an owner, as labelled items", async () => {
    const items = await openMenu(owner);
    expect(items).toContain("Rename workspace");
    expect(items).toContain("Archive workspace");
    expect(items).not.toContain("Unarchive workspace");
    expect(items).toContain("Create workspace");
  });

  it("shows Unarchive workspace, not Archive, to an owner of an archived workspace", async () => {
    const items = await openMenu({ ...owner, workspace: { ...ws, archivedAt: "2026-11-10T00:00:00Z" } });
    expect(items).toContain("Unarchive workspace");
    expect(items).not.toContain("Archive workspace");
  });

  it("shows an admin Rename workspace only", async () => {
    const items = await openMenu(admin);
    expect(items).toContain("Rename workspace");
    expect(items).not.toContain("Archive workspace");
  });

  it("shows a member neither", async () => {
    const items = await openMenu(member);
    expect(items).not.toContain("Rename workspace");
    expect(items).not.toContain("Archive workspace");
    expect(items).not.toContain("Unarchive workspace");
    expect(items).toContain("Create workspace");
  });

  it("shows nothing while the info is loading", async () => {
    const items = await openMenu(null);
    expect(items.filter((t) => t?.includes("workspace") && t !== "Create workspace")).toEqual([]);
  });

  it("Rename workspace's sheet: the name and Save, no subtitle; Save renames and closes", async () => {
    const renamed: string[] = [];
    let open = true;
    render(<RenameWorkspaceSheet open workspace={ws} onOpenChange={(o) => (open = o)} onRename={async (n) => (renamed.push(n), null)} />);
    const sheet = screen.getByRole("dialog");
    expect(sheet.textContent).toContain("Rename workspace");
    expect(sheet.querySelector('[data-slot="sheet-description"]')).toBeNull();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // unchanged
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Acme Labs" } });
    fireEvent.click(save);
    await act(async () => undefined);
    expect(renamed).toEqual(["Acme Labs"]);
    expect(open).toBe(false);
  });

  it("Rename workspace's sheet shows Mynt's refusal and stays open", async () => {
    render(<RenameWorkspaceSheet open workspace={ws} onOpenChange={noop} onRename={async () => "Only the workspace's owners and admins can rename it."} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toBe("Only the workspace's owners and admins can rename it.");
  });

  it("Archive workspace's sheet confirms with the consequence; Yes archives", async () => {
    const archived: string[] = [];
    render(<ConfirmWorkspaceSheet kind="archive" open workspace={ws} onOpenChange={noop} onConfirm={async () => (archived.push("x"), null)} />);
    const sheet = screen.getByRole("dialog");
    expect(sheet.textContent).toContain("Archive Acme?");
    expect(sheet.textContent).toContain("Archiving freezes the workspace; 7 days later everyone is removed. Until then it can be undone.");
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive workspace" }));
    await act(async () => undefined);
    expect(archived).toEqual(["x"]);
    expect(screen.getByText("Archived. You can unarchive it for 7 days.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, archive workspace" })).toBeNull();
  });

  it("Unarchive workspace's sheet says when everyone is removed; Yes unarchives", async () => {
    const done: string[] = [];
    const archivedWs = { ...ws, archivedAt: "2026-11-10T00:00:00Z", offboardingAt: "2026-11-17T00:00:00Z" };
    render(<ConfirmWorkspaceSheet kind="unarchive" open workspace={archivedWs} onOpenChange={noop} onConfirm={async () => (done.push("x"), null)} />);
    expect(screen.getByRole("dialog").textContent).toContain("unless you unarchive it");
    fireEvent.click(screen.getByRole("button", { name: "Yes, unarchive workspace" }));
    await act(async () => undefined);
    expect(done).toEqual(["x"]);
    expect(screen.getByText("Unarchived. Nobody was removed.")).toBeTruthy();
  });
});

describe("/members", () => {
  it("redirects to the Settings page's Members tab", async () => {
    const { default: MembersPage } = await import("@/app/(studio)/members/page");
    let to: string | undefined;
    try {
      MembersPage();
    } catch (e) {
      to = (e as { digest?: string }).digest;
    }
    expect(to).toContain("/settings?tab=members");
  });
});

describe("/workspace", () => {
  it("redirects to Settings on the same tab, its old Settings tab (and General) to the first tab", async () => {
    const { default: WorkspacePage } = await import("@/app/(studio)/workspace/page");
    const to = async (tab?: string) => {
      try {
        await WorkspacePage({ searchParams: Promise.resolve(tab ? { tab } : {}) });
      } catch (e) {
        return (e as { digest?: string }).digest;
      }
    };
    expect(await to("apps")).toContain("/settings?tab=apps");
    expect(await to("repositories")).toContain("/settings?tab=repositories");
    expect(await to("settings")).toContain("/settings?tab=members");
    expect(await to("general")).toContain("/settings?tab=members");
    expect(await to()).toContain("/settings?tab=members");
  });
});

const attention = fromAttention({
  items: [
    { id: "x1", kind: "licence", severity: "low", title: "Licence renews in 50 days", detail: "Harbor Bank, CA", href: "/licences", at: "2026-11-01T00:00:00Z" },
    { id: "x2", kind: "build", severity: "high", title: "Cards' build failed", detail: "Typecheck failed", href: "/a1", at: "2026-11-12T00:00:00Z" },
    { id: "x3", severity: "medium", title: "Bad link", href: "javascript:alert(1)" },
    { id: "x5", severity: "low", title: "Partner portal", href: "https://partner.example.test/review" },
    { id: "x4", severity: "high" },
  ],
});
const dashboard = fromDashboardTool({ apps: [{ app_id: "a1", name: "Cards", status: "published" }] });

describe("the dashboard's sections", () => {
  it("Needs attention lists items, most severe first, with a severity dot, detail and link", () => {
    expect(attention.map((i) => i.id)).toEqual(["x2", "x3", "x1", "x5"]); // x4 has no title
    const html = renderToStaticMarkup(<NeedsAttention state={{ kind: "ready", data: attention }} />);
    expect(html).toMatch(/data-severity="high"[\s\S]*?data-tone="red"[\s\S]*?High/);
    expect(html).toContain("Typecheck failed");
    expect(html).toContain('href="/a1"');
    // Only studio pages are links: another site (even https) or javascript: is plain text, never clickable.
    expect(html.match(/>Open</g)).toHaveLength(2);
    expect(html).not.toMatch(/href="(javascript|https):/);
    expect(html).not.toContain("target=\"_blank\"");
    expect(html).toMatch(/data-plain-link[^>]*>https:\/\/partner\.example\.test\/review</);
    expect(attention.find((i) => i.id === "x5")).toMatchObject({ href: null, linkText: "https://partner.example.test/review" });
  });

  it("Needs attention shows nothing when nothing needs you, or says it isn't available yet, never an empty list", () => {
    const nothing = renderToStaticMarkup(<NeedsAttention state={{ kind: "ready", data: [] }} />);
    expect(nothing).toBe("");
    const unsupported = renderToStaticMarkup(<NeedsAttention state={{ kind: "unsupported" }} />);
    expect(unsupported).toContain('data-empty="not-available"');
    expect(unsupported).toContain("isn&#x27;t available yet");
    expect(renderToStaticMarkup(<NeedsAttention state={{ kind: "unavailable", message: "This workspace's data comes with Mynt's next update." }} />)).toContain("next update");
  });

  it("Apps by stage is a funnel: Ideas → Staging → Production with counts, each app a chip with its checks passing", () => {
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
    // Ideas first, then Staging, then Production.
    expect(html.indexOf('data-step="idea"')).toBeLessThan(html.indexOf('data-step="staging"'));
    expect(html.indexOf('data-step="staging"')).toBeLessThan(html.indexOf('data-step="production"'));
    expect(html.match(/data-chip=/g)).toHaveLength(4);
    expect(html).toMatch(/data-chip="a2"[\s\S]*?data-checks[^>]*>1\/1</);
    expect(html).toMatch(new RegExp(`data-chip="a3"[\\s\\S]*?data-checks[^>]*>${blocked.passing}/${blocked.total}<`));
    expect(blocked.total).toBeGreaterThan(blocked.passing ?? 0);
    expect(html).toMatch(/data-chip="a4"[\s\S]*?Not checked/);
    expect(html).toMatch(/data-chip="a1"[\s\S]*?Live/);
    expect(html).not.toContain("<table");
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

  it("all sit on the dashboard, with no cards", () => {
    const html = renderToStaticMarkup(
      <DashboardView
        dashboard={dashboard}
        attention={{ kind: "ready", data: [] }}
        stages={{ kind: "ready", data: { checks: false, apps: [{ id: "a1", name: "Cards", stage: "production", readiness: null }] } }}
        activity={{ kind: "unsupported" }}
      />,
    );
    expect(html).toContain('data-section="recent-activity"');
    expect(html).toContain("Money moved");
    // Nothing needs you: no strip at all; apps by stage and the workspace facts aren't on the dashboard.
    for (const gone of ['data-strip="attention"', "Nothing needs you right now", 'data-section="apps-by-stage"', 'data-fact="active-products"']) expect(html).not.toContain(gone);
    expect(html).not.toContain('data-slot="card"');
  });
});
