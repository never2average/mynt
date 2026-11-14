// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";

// The dashboard's GitHub tile: the username, up to five connected repositories with their
// approval, View all, and Connect repository (connect_repository), plus the route behind it.

const fake = { tools: [] as { name: string }[], calls: [] as { name: string; args: Record<string, unknown> }[], connectReply: {} as unknown };
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => undefined, replace: () => undefined }) }));
vi.mock("@/lib/session", () => ({
  currentSession: async () => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() }) as Session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "whoami") return ok({ id: "u1", effective_roles: ["developer"] });
      if (name === "list_repositories")
        return ok([
          { repository: "ines/savings", approval: "approved", approval_note: "ines can push (write), checked with GitHub", created_at: "2026-11-01T00:00:00Z", managed: false },
          { repository: "mynt-apps/app-a1", approval: "approved", managed: true },
        ]);
      if (name === "connect_repository") return ok(fake.connectReply);
      return ok({});
    },
    close: async () => undefined,
  }),
}));

const { DashboardView } = await import("@/components/dashboard-view");
const { RepositoriesTab, ConnectResultView } = await import("@/components/repositories");
const { fromConnectRepository, fromListRepositories } = await import("@/lib/repositories");
const { fromDashboardTool } = await import("@/lib/dashboard");
const route = await import("@/app/api/repositories/route");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const repo = (repository: string, approval: "approved" | "pending" | "rejected", note: string | null = null) => ({ repository, approval, note, connectedAt: null });
const repos = [
  repo("ines/savings", "approved"),
  repo("ines/cards", "pending", "Link your GitHub account so Mynt can check you can push"),
  repo("ines/vault", "rejected", "Not a repository of this team"),
];
const dashboard = fromDashboardTool({});
const linked = { supported: true, github: "ines", wallet: null, manageUrl: "https://accounts.example.test/user" };

describe("the dashboard's workspace facts", () => {
  it("show the GitHub username, how many repositories are connected (listed in Settings) and Connect repository", () => {
    const html = renderToStaticMarkup(<DashboardView dashboard={dashboard} linked={linked} repos={{ kind: "ready", repos, connect: true }} />);
    const line = html.slice(html.indexOf('data-facts="workspace"'));
    expect(line).toMatch(/data-fact="github"[\s\S]*?ines/);
    expect(line).toMatch(/href="\/settings\?tab=repositories"[^>]*>3 connected</);
    expect(line).toMatch(/>\s*Connect repository\s*</);
    // The list itself is on Settings > Repositories, not the dashboard.
    expect(html).not.toContain("data-repo=");
  });

  it("say when Mynt doesn't list repositories yet, and disable Connect then", () => {
    const html = renderToStaticMarkup(<DashboardView dashboard={dashboard} linked={linked} repos={{ kind: "unsupported" }} />);
    expect(html).toMatch(/data-fact="repositories"[\s\S]*?Not available yet/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-connect-repository/);
  });

  it("connects a valid owner/name and shows Mynt's answer", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ result: { kind: "pending", repository: "ines/cards", why: "read-only access", manageUrl: "https://accounts.example.test/user" } }), { status: 200 });
    });
    const connected: string[] = [];
    render(<DashboardView dashboard={dashboard} linked={linked} repos={{ kind: "ready", repos: [], connect: true }} onReposChanged={() => connected.push("x")} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
    const input = screen.getByLabelText("Repository (owner/name)");
    fireEvent.change(input, { target: { value: "not a repo" } });
    const submit = screen.getAllByRole("button", { name: "Connect repository" }).find((b) => b.getAttribute("type") === "submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "ines/cards" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await act(async () => undefined);
    expect(sent).toEqual([{ repository: "ines/cards" }]);
    expect(screen.getByText(/sent to an admin for approval\. Why: read-only access\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Link your GitHub account/ }).getAttribute("href")).toBe("https://accounts.example.test/user");
    expect(connected).toEqual(["x"]);
  });
});

describe("connect_repository's answers", () => {
  it("approved now, sent to an admin with why, rejected, or install the app first", () => {
    expect(fromConnectRepository({ connected: true, approval: "approved" }, "a/b")).toEqual({ kind: "approved", repository: "a/b" });
    expect(fromConnectRepository({ connected: true, approval: "pending_approval", why: "link GitHub", manage_url: "javascript:x" }, "a/b")).toEqual({ kind: "pending", repository: "a/b", why: "link GitHub", manageUrl: null });
    expect(fromConnectRepository({ connected: false, install_url: "https://github.com/apps/mynt/installations/new" }, "a/b")).toMatchObject({ kind: "install", installUrl: "https://github.com/apps/mynt/installations/new" });
    expect(renderToStaticMarkup(<ConnectResultView result={{ kind: "approved", repository: "a/b" }} />)).toContain("connected and approved");
    expect(renderToStaticMarkup(<ConnectResultView result={{ kind: "rejected", repository: "a/b", why: null, manageUrl: null }} />)).toContain("an admin rejected access");
  });

  it("list_repositories: the developer's own, never apps' Mynt-managed ones", () => {
    expect(fromListRepositories([{ repository: "a/b", approval: "pending_approval" }, { repository: "m/x", approval: "approved", managed: true }, { repository: "bad" }])).toEqual([
      { repository: "a/b", approval: "pending", note: null, connectedAt: null },
    ]);
  });
});

describe("the Repositories tab", () => {
  it("lists every repository in a paged table with its status, note and a GitHub link", () => {
    const html = renderToStaticMarkup(<RepositoriesTab state={{ kind: "ready", repos, connect: true }} />);
    expect(html.match(/data-repo-row=/g)).toHaveLength(3);
    expect(html).toContain('href="https://github.com/ines/cards"');
    expect(html).toContain("Not a repository of this team");
    expect(html).toContain('aria-label="Search repositories by name or status"');
    expect(renderToStaticMarkup(<RepositoriesTab state={{ kind: "unsupported" }} />)).toContain('data-empty="not-available"');
  });
});

describe("repositories route", () => {
  const post = (body: unknown, origin = "http://localhost:3000") =>
    new Request("http://localhost:3000/api/repositories", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists them where Mynt has list_repositories, and says whether it can connect", async () => {
    fake.tools = [];
    expect(await (await route.GET()).json()).toEqual({ supported: false });
    fake.tools = [{ name: "list_repositories" }];
    const body = await (await route.GET()).json();
    expect(body).toMatchObject({ supported: true, connect: false });
    expect(body.repositories.map((r: { repository: string }) => r.repository)).toEqual(["ines/savings"]);
  });

  it("connects only a valid owner/name, from the studio's own origin, where Mynt offers it", async () => {
    fake.tools = [{ name: "list_repositories" }];
    fake.calls = [];
    expect((await route.POST(post({ repository: "ines/cards" }))).status).toBe(501);
    fake.tools = [{ name: "list_repositories" }, { name: "connect_repository" }];
    expect((await route.POST(post({ repository: "ines/cards; rm" }))).status).toBe(400);
    expect((await route.POST(post({ repository: "ines/cards" }, "https://evil.example"))).status).toBe(403);
    expect(fake.calls.filter((c) => c.name === "connect_repository")).toHaveLength(0);
    fake.connectReply = { connected: true, repository: "ines/cards", approval: "approved" };
    const res = await route.POST(post({ repository: "ines/cards" }));
    expect(await res.json()).toEqual({ result: { kind: "approved", repository: "ines/cards" } });
    expect(fake.calls.find((c) => c.name === "connect_repository")?.args).toEqual({ repository: "ines/cards" });
  });
});
