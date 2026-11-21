// @vitest-environment jsdom
// Settings' Members, Invitations and Apps tabs filter from one Filters popover: the count on its
// button, the facet's heading, chips that pick any number (a row matches any of them), and one
// Clear all. (Repositories: test/repositories.test.tsx.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { clearAll, filtersButton, headings, oneFiltersButton, openFilters, toggle } from "./facet-helpers";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { InvitationsTab, MembersTab } = await import("@/components/members-view");
const { AppsTab } = await import("@/components/workspace-view");

afterEach(cleanup);

const acme = { id: "w1", name: "Acme", role: "owner" as const };
const noop = { invite: async () => null, changeRole: async () => null, remove: async () => null, revoke: async () => null };
const data = {
  supported: true,
  canManage: true,
  members: [
    { userId: "u1", name: "Ines Diaz", email: "ines@example.com", role: "owner" as const },
    { userId: "u2", name: "Sam Lee", email: "sam@example.com", role: "member" as const },
    { userId: "u3", name: "Ana Ruiz", email: "ana@example.com", role: "admin" as const },
  ],
  invites: [
    { id: "i1", email: "new@example.com", role: "admin" as const, expiresAt: null },
    { id: "i2", email: "dev@example.com", role: "member" as const, expiresAt: null },
  ],
};
const rowCount = (c: HTMLElement) => c.querySelectorAll("tbody tr").length;

describe("Settings' Filters popovers", () => {
  it("Members: Role, any of the picked roles, one Clear all", async () => {
    const { container: c } = render(<MembersTab workspace={acme} data={data} actions={noop} />);
    oneFiltersButton(c.querySelector("[data-list-layout]")!);
    await openFilters(c);
    expect(headings()).toEqual(["Role"]);
    await toggle("role", "owner");
    expect(rowCount(c)).toBe(1);
    await toggle("role", "admin");
    expect(rowCount(c)).toBe(2);
    expect(c.textContent).not.toContain("Sam Lee");
    expect(filtersButton(c).textContent).toBe("Filters· 2");
    await clearAll();
    expect(rowCount(c)).toBe(3);
    expect(filtersButton(c).textContent).toBe("Filters");
  });

  it("Invitations: Role, any of the picked roles, one Clear all", async () => {
    const { container: c } = render(<InvitationsTab workspace={acme} data={data} actions={noop} />);
    oneFiltersButton(c.querySelector("[data-list-layout]")!);
    await openFilters(c);
    expect(headings()).toEqual(["Role"]);
    await toggle("role", "member");
    expect(rowCount(c)).toBe(1);
    expect(c.textContent).toContain("dev@example.com");
    await toggle("role", "admin");
    expect(rowCount(c)).toBe(2);
    await clearAll();
    expect(filtersButton(c).textContent).toBe("Filters");
  });

  it("Apps: Stage, any of the picked stages, one Clear all", async () => {
    const apps = [
      { id: "a1", name: "Cards", stage: "production" as const, owner: "Ines", lastBuild: null },
      { id: "a2", name: "Budgeting", stage: "idea" as const, owner: null, lastBuild: null },
      { id: "a3", name: "Payroll", stage: "staging" as const, owner: null, lastBuild: null },
    ];
    const { container: c } = render(<AppsTab workspace={acme} apps={apps} />);
    oneFiltersButton(c.querySelector("[data-list-layout]")!);
    await openFilters(c);
    expect(headings()).toEqual(["Stage"]);
    const shown = () => [...c.querySelectorAll("[data-app-row]")].map((r) => r.getAttribute("data-app-row"));
    await toggle("stage", "idea");
    await toggle("stage", "staging");
    expect(shown()).toEqual(["a2", "a3"]);
    expect(filtersButton(c).textContent).toBe("Filters· 2");
    await clearAll();
    expect(shown()).toEqual(["a1", "a2", "a3"]);
  });
});
