import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InvitationsBanner } from "@/components/invitations";
import { fromInvitations, ROLE_GRANTS } from "@/lib/invitations";
import { fromListWorkspaces, selectWorkspace } from "@/lib/workspaces";

const invitations = fromInvitations({
  invitations: [
    { id: "inv1", workspace: { id: "w7", name: "Gamma" }, invited_by: { name: "Sam Lee" }, role: "admin", grants: ["Build the workspace's apps"], expires_at: "2026-11-20T00:00:00Z" },
    { id: "inv2", workspace_id: "w8", workspace_name: "Delta", inviter: { email: "ana@example.com" }, role: "owner?" },
    { id: "bad id!", workspace: { name: "Bad" } },
  ],
});

describe("invitations", () => {
  it("read the workspace, inviter, role and grants, with the role's grants when Mynt doesn't say", () => {
    expect(invitations).toHaveLength(2);
    expect(invitations[0]).toMatchObject({ id: "inv1", workspaceId: "w7", workspaceName: "Gamma", inviter: "Sam Lee", role: "admin", grants: ["Build the workspace's apps"] });
    expect(invitations[1]).toMatchObject({ workspaceId: "w8", workspaceName: "Delta", inviter: "ana@example.com", role: "member", grants: ROLE_GRANTS.member });
    expect(fromInvitations(null)).toEqual([]);
  });

  it("show on the dashboard with Accept and Decline for each, and nothing when there are none", () => {
    const html = renderToStaticMarkup(<InvitationsBanner invitations={invitations} onAnswer={async () => null} />);
    for (const t of ["invited to 2 workspaces", "only if you accept", "Gamma", "Invited by Sam Lee", "admin", "Build the workspace&#x27;s apps", "Delta", "until 2026-11-20"]) expect(html).toContain(t);
    expect((html.match(/>Accept</g) ?? []).length).toBe(2);
    expect((html.match(/>Decline</g) ?? []).length).toBe(2);
    expect(renderToStaticMarkup(<InvitationsBanner invitations={[]} onAnswer={async () => null} />)).toBe("");
  });
});

describe("the user's own workspace", () => {
  it("is read from list_workspaces and selected by default over workspaces they joined", () => {
    const list = fromListWorkspaces({ workspaces: [{ id: "w1", name: "Acme", role: "member" }, { id: "me", name: "Ines", role: "owner", kind: "personal" }] });
    expect(list[1]).toMatchObject({ id: "me", personal: true });
    expect(list[0].personal).toBeUndefined();
    expect(selectWorkspace(list, null).id).toBe("me");
    expect(selectWorkspace(list, "w1").id).toBe("w1");
  });
});
