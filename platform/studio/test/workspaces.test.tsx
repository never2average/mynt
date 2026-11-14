import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarView } from "@/components/app-sidebar";
import { MembersView, type MembersData } from "@/components/members-view";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  canManageMembers,
  fromListMembers,
  fromListWorkspaces,
  groupByStage,
  PERSONAL,
  selectWorkspace,
  stageOf,
} from "@/lib/workspaces";

describe("workspaces", () => {
  it("reads list_workspaces, and falls back to the remembered one or the first", () => {
    const ws = fromListWorkspaces({ workspaces: [{ id: "w1", name: "Acme", role: "owner" }, { id: "w2", name: "Beta", role: "member" }, { id: "../x" }] });
    expect(ws.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(selectWorkspace(ws, "w2").name).toBe("Beta");
    expect(selectWorkspace(ws, "gone").id).toBe("w1");
    expect(selectWorkspace([], null)).toBe(PERSONAL);
  });

  it("lets only owners and admins manage members", () => {
    expect([canManageMembers("owner"), canManageMembers("admin"), canManageMembers("member"), canManageMembers(undefined)]).toEqual([true, true, false, false]);
  });

  it("reads members and invites", () => {
    const r = fromListMembers({
      members: [{ user_id: "u1", name: "Ines", email: "ines@example.com", role: "owner" }, { id: "u2", role: "nonsense" }],
      invites: [{ id: "i1", email: "new@example.com", role: "admin", expires_at: "2026-11-20" }, { id: "i2" }],
    });
    expect(r.members.map((m) => [m.userId, m.role])).toEqual([["u1", "owner"], ["u2", "member"]]);
    expect(r.invites).toEqual([{ id: "i1", email: "new@example.com", role: "admin", expiresAt: "2026-11-20" }]);
  });
});

describe("folders by stage", () => {
  it("use Mynt's stage when it gives one", () => {
    expect(stageOf({ stage: "staging", status: "published" })).toBe("staging");
  });

  it("until then, derive it: published is production, a good build is staging, else an idea", () => {
    expect(stageOf({ status: "published" })).toBe("production");
    expect(stageOf({ status: "draft" }, { status: "succeeded" })).toBe("staging");
    expect(stageOf({ status: "draft" }, { status: "coding", previewUrl: "https://pv.example.com/" })).toBe("staging");
    expect(stageOf({ status: "draft" }, { status: "failed" })).toBe("idea");
    expect(stageOf({ status: "draft" })).toBe("idea");
  });

  it("group the workspace's apps, sorted by name", () => {
    const g = groupByStage([
      { id: "b", name: "Budgeting", stage: "staging" },
      { id: "a", name: "Allowance", stage: "staging" },
      { id: "c", name: "Cards", stage: "production" },
    ]);
    expect(g.staging.map((a) => a.name)).toEqual(["Allowance", "Budgeting"]);
    expect(g.production.map((a) => a.id)).toEqual(["c"]);
    expect(g.idea).toEqual([]);
  });
});

function sidebar(over: Partial<Parameters<typeof SidebarView>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarView
          workspaces={[{ id: "w1", name: "Acme", role: "owner" }, { id: "w2", name: "Beta", role: "member" }]}
          selected={{ id: "w1", name: "Acme", role: "owner" }}
          supported
          groups={groupByStage([
            { id: "app-p", name: "Round-up savings", stage: "production" },
            { id: "app-s", name: "Budgeting", stage: "staging" },
            { id: "app-i", name: "Crypto vault", stage: "idea" },
          ])}
          account={{ name: "Ines Diaz", email: "ines@example.com" }}
          pathname="/"
          onSelectWorkspace={() => undefined}
          onCreateWorkspace={async () => null}
          {...over}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe("sidebar", () => {
  it("shows the selected workspace in the switcher, then Dashboard, Coverage, Licences and Audits, then the three folders", () => {
    const html = sidebar();
    expect(html).toContain("Acme");
    expect(html).toContain('aria-label="Switch workspace"');
    for (const href of ["/coverage", "/licences", "/audits"]) expect(html).toContain(`href="${href}"`);
    const order = ["Switch workspace", ">Dashboard<", ">Coverage<", ">Licences<", ">Audits<", ">Production<", ">Staging<", ">Ideas<"].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('href="/app-p"');
    expect(html).toContain('href="/app-s"');
  });

  it("has no Builds or New app item", () => {
    const html = sidebar();
    expect(html).not.toMatch(/>\s*Builds\s*</);
    expect(html).not.toMatch(/>\s*New app\s*</);
    expect(html).not.toContain('href="/builds"');
    expect(html).not.toContain('href="/new"');
  });

  it("shows the one account, with an icon-only Log out on its row (not inside a menu)", () => {
    const html = sidebar();
    expect(html).toContain("Ines Diaz");
    expect(html).toContain("ines@example.com");
    // Rendered with the page, on the account's row, without opening anything; it posts to logout.
    const form = html.slice(html.indexOf('action="/api/auth/logout"'));
    const inForm = form.slice(0, form.indexOf("</form>"));
    expect(html).toContain('method="post"');
    expect(inForm).toMatch(/<button[^>]*type="submit"/);
    expect(inForm).toContain('aria-label="Log out"');
    expect(inForm).not.toMatch(/>\s*Log out\s*</); // no visible label: the icon (and its tooltip) only
    expect(html).not.toMatch(/switch account|add account/i);
  });
});

const members: MembersData = {
  supported: true,
  canManage: true,
  members: [
    { userId: "u1", name: "Ines Diaz", email: "ines@example.com", role: "owner" },
    { userId: "u2", name: "Sam Lee", email: "sam@example.com", role: "member" },
  ],
  invites: [{ id: "i1", email: "new@example.com", role: "admin", expiresAt: null }],
};
const noop = { invite: async () => null, changeRole: async () => null, remove: async () => null, revoke: async () => null };
const membersHtml = (data: MembersData) => renderToStaticMarkup(<MembersView workspace={{ id: "w1", name: "Acme", role: "owner" }} data={data} actions={noop} />);

describe("Members page", () => {
  it("lets owners and admins invite, change roles, remove and revoke", () => {
    const html = membersHtml(members);
    expect(html).toContain("data-invite-form");
    expect(html).toContain('aria-label="Role for sam@example.com"');
    expect(html).toContain(">Remove<");
    expect(html).toContain(">Revoke<");
    expect(html).not.toContain('aria-label="Role for ines@example.com"'); // the owner's role isn't changed here
  });

  it("shows everyone else the list only", () => {
    const html = membersHtml({ ...members, canManage: false });
    expect(html).toContain("data-read-only");
    expect(html).toContain("Sam Lee");
    expect(html).not.toContain("data-invite-form");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain(">Revoke<");
    expect(html).not.toContain("<select");
  });

  it("says when Mynt doesn't have workspaces yet", () => {
    const html = membersHtml({ supported: false, canManage: false, members: [], invites: [], message: "Workspace members come with Mynt's next update." });
    expect(html).toContain("next update");
    expect(html).not.toContain("data-invite-form");
  });
});
