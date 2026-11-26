// @vitest-environment jsdom
// What the production smoke test found, in the browser: who sees which page, the first-run
// workspace step, Settings with no workspace, Ask AI's errors and the signed-out page.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const root = process.cwd();
const { pageGateFor, DeveloperGate, CreateWorkspace, FOR_DEVELOPERS } = await import("@/components/studio-gates");
const { SidebarView } = await import("@/components/app-sidebar");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { askErrorText, ASK_ERRORS, ASK_FAILED, askFetch } = await import("@/lib/ask-client");
const { withWorkspace, PERSONAL, isRealWorkspaceId } = await import("@/lib/workspaces");
const { NOT_SCOPED, NO_WORKSPACE } = await import("@/lib/workspace-server");
const { WorkspaceUnavailable } = await import("@/app/(studio)/settings/workspace-page");
const { default: SignedOutPage } = await import("@/app/signed-out/page");
const { OPEN_PAGES, pageNeedsSignIn } = await import("@/lib/page-gate");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const dev = { developer: true, liquidity: { builder: true, liquidityProvider: false }, owner: null };
const lp = { developer: false, liquidity: { builder: false, liquidityProvider: true }, owner: null };
const consumer = { developer: false, liquidity: { builder: false, liquidityProvider: false }, owner: null };

describe("who sees which page", () => {
  it("developers see everything; liquidity providers the dashboard and Earn; everyone else the one gate", () => {
    const pages = ["/", "/licences", "/audits", "/settings", "/new", "/builds", "/earn", "/app-1"];
    expect(pages.map((p) => pageGateFor(p, dev, false))).toEqual(pages.map(() => "none"));
    expect(pages.map((p) => pageGateFor(p, lp, false))).toEqual(["none", "developer", "developer", "developer", "developer", "developer", "none", "developer"]);
    expect(pages.map((p) => pageGateFor(p, consumer, false))).toEqual(pages.map(() => "developer"));
  });

  it("a developer with no workspace creates one first (Earn still opens)", () => {
    expect(["/", "/licences", "/settings", "/new", "/earn"].map((p) => pageGateFor(p, dev, true))).toEqual(["workspace", "workspace", "workspace", "workspace", "none"]);
  });

  it("the gate is one message, with no build form", () => {
    const html = renderToStaticMarkup(<DeveloperGate />);
    expect(html).toContain(FOR_DEVELOPERS);
    expect(html).not.toMatch(/<form|<textarea|<input/);
  });

  it("non-developers' sidebar has only Dashboard (and Earn for liquidity providers): no Licences, Audits, Settings, workspaces or apps", () => {
    const side = (developer: boolean, liquidity: boolean) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <SidebarProvider>
            <SidebarView workspaces={[PERSONAL]} selected={PERSONAL} supported={false} groups={null} account={{ name: "Sam", email: null }} pathname="/" onSelectWorkspace={() => undefined} onCreateWorkspace={async () => null} liquidity={liquidity} developer={developer} />
          </SidebarProvider>
        </TooltipProvider>,
      );
    const consumerHtml = side(false, false);
    for (const gone of ['href="/licences"', 'href="/audits"', 'href="/settings"', "Switch workspace", "data-folder"]) expect(consumerHtml, gone).not.toContain(gone);
    expect(consumerHtml).toContain('href="/"');
    expect(side(false, true)).toContain('href="/earn"');
    expect(side(true, false)).toContain('href="/licences"');
  });

  it("the shell gates pages and only developers' requests fire for developers", () => {
    const shell = readFileSync(join(root, "app/(studio)/studio-shell.tsx"), "utf8");
    expect(shell).toMatch(/<WorkspaceProvider enabled=\{access\?\.developer === true\}>/);
    expect(shell).toMatch(/pageGateFor\(pathname, access, needsWorkspace\)/);
    const header = readFileSync(join(root, "components/site-header.tsx"), "utf8");
    expect(header).toMatch(/<DeveloperOnly>[\s\S]*<GithubControl \/>[\s\S]*<WalletControl \/>[\s\S]*<NewAppButton \/>[\s\S]*<\/DeveloperOnly>/);
  });
});

describe("the first-run workspace step", () => {
  it("names a workspace and creates it; Mynt's refusal is shown", async () => {
    const names: string[] = [];
    render(<CreateWorkspace onCreate={async (n) => (names.push(n), names.length === 1 ? "That name is taken" : null)} />);
    const input = screen.getByLabelText("Workspace name");
    const button = screen.getByRole("button", { name: "Create workspace" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  Acme Labs " } });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(names).toEqual(["Acme Labs"]);
    expect(screen.getByRole("alert").textContent).toBe("That name is taken");
  });

  it("is a page of its own, centred, in a panel with the dashboard's section heading", () => {
    const html = renderToStaticMarkup(<CreateWorkspace onCreate={async () => null} />);
    expect(html).toMatch(/data-gate="workspace"/);
    expect(html).toMatch(/class="flex flex-1 flex-col items-center justify-center[^"]*" data-gate="workspace"/);
    expect(html).toContain("data-panel");
    expect(html).toMatch(/<h2 [^>]*class="text-sm font-semibold"[^>]*>Create your workspace<\/h2>/);
    expect(renderToStaticMarkup(<DeveloperGate />)).toMatch(/<h2 class="text-sm font-semibold">/);
  });
});

describe("workspaces in requests", () => {
  it("never send the synthetic 'personal' id", () => {
    expect(withWorkspace("/api/projects", PERSONAL)).toBe("/api/projects");
    expect(withWorkspace("/api/audit?class=financial", PERSONAL)).toBe("/api/audit?class=financial");
    expect(withWorkspace("/api/projects", { id: "w1" })).toBe("/api/projects?workspace=w1");
    expect(withWorkspace("/api/audit?class=financial", { id: "w 1" })).toBe("/api/audit?class=financial&workspace=w%201");
    expect([isRealWorkspaceId("personal"), isRealWorkspaceId("w1"), isRealWorkspaceId("../x")]).toEqual([false, true, false]);
    for (const f of ["lib/use-compliance.ts", "components/app-sidebar.tsx", "components/kbar/sources.ts", "app/(studio)/page.tsx", "app/(studio)/audits/page.tsx"])
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/workspace=\$\{/);
  });

  it("say accurately why data is missing: no workspace yet, or not scoped yet; never 'Personal still shows everything'", () => {
    expect(NO_WORKSPACE).toMatch(/don't have a workspace yet/);
    expect(NOT_SCOPED).not.toMatch(/Personal/);
  });
});

describe("Settings with no workspace to show", () => {
  it("keeps a way on: another workspace, or a new one", async () => {
    const picked: string[] = [];
    render(<WorkspaceUnavailable message="That workspace isn't one of yours." others={[{ id: "w2", name: "Beta", role: "member" }]} onSelect={(id) => picked.push(id)} />);
    expect(screen.getByText("That workspace isn't one of yours.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(picked).toEqual(["w2"]);
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
    // The form inline, not the full-page gate's centring wrapper; no dashed box.
    expect(document.querySelector('[data-gate="workspace"]')).toBeNull();
    expect(document.querySelector("[data-workspace-unavailable]")?.className).not.toContain("border-dashed");
    const page = readFileSync(join(root, "app/(studio)/settings/workspace-page.tsx"), "utf8");
    expect(page).toMatch(/error \? \([\s\S]*?<TabSelector tab=\{tab\} onTab=\{onTab\} \/>[\s\S]*?<WorkspaceUnavailable/);
  });
});

describe("Ask AI's errors", () => {
  it("read as sentences, never raw JSON", async () => {
    expect(askErrorText(JSON.stringify({ error: "not_developer", message: "Mynt Studio is for developers." }))).toBe(ASK_ERRORS.not_developer);
    expect(askErrorText(JSON.stringify({ error: "too_large", message: "That conversation is too long. Start a new chat." }))).toBe("That conversation is too long. Start a new chat.");
    expect(askErrorText(JSON.stringify({ error: "weird" }))).toBe(ASK_FAILED);
    expect(askErrorText("<html>502</html>")).toBe(ASK_FAILED);
    expect(askErrorText("")).toBe(ASK_FAILED);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "not_developer", message: "x" }), { status: 403 }));
    const res = await askFetch("/api/ask", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(ASK_ERRORS.not_developer);
  });
});

describe("the signed-out page", () => {
  it("renders its own page with Sign in again, and needs no sign-in (never a redirect)", () => {
    expect(OPEN_PAGES.has("/signed-out")).toBe(true);
    expect(pageNeedsSignIn("/signed-out")).toBe(false);
    const html = renderToStaticMarkup(<SignedOutPage />);
    expect(html).toContain("You&#x27;re signed out.");
    expect(html).toMatch(/href="\/api\/auth\/login"[^>]*>Sign in again</);
  });
});
