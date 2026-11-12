import { describe, expect, it } from "vitest";
import { buildPreviewUrl, safePreviewUrl, toProjects } from "@/lib/projects";

const apps = [
  { id: "app-old", name: "Savings", description: "d", status: "draft", updated_at: "2026-11-01T00:00:00Z" },
  { id: "app-new", name: "Cards", description: "", status: "published", updated_at: "2026-11-10T00:00:00Z" },
];

const builds = {
  month_spend_usd: 1,
  builds: [
    { id: "b1", app_id: "app-new", goal: "First   version", status: "succeeded", preview_url: "https://pv-1.preview.example/", created_at: "2026-11-02", updated_at: "2026-11-02" },
    { id: "b2", app_id: "app-new", goal: "Add a balance screen", status: "coding", preview_url: null, created_at: "2026-11-09", updated_at: "2026-11-09" },
    { id: "b3", app_id: null, goal: "No app", status: "failed", updated_at: "2026-11-09" },
    { id: "b4", app_id: "someone-elses-app", goal: "x", status: "succeeded", updated_at: "2026-11-09" },
  ],
};

describe("toProjects", () => {
  it("maps apps to projects, newest first, with their builds as conversations", () => {
    const projects = toProjects(apps, builds);
    expect(projects.map((p) => p.id)).toEqual(["app-new", "app-old"]);
    const cards = projects[0];
    expect(cards.conversations.map((c) => c.id)).toEqual(["b2", "b1"]);
    expect(cards.conversations[1].title).toBe("First version");
    expect(cards.previewUrl).toBe("https://pv-1.preview.example/"); // newest build that has one
    expect(projects[1]).toMatchObject({ name: "Savings", previewUrl: null, conversations: [] });
    expect(projects[0]).not.toHaveProperty("updatedAt");
  });

  it("copes with unexpected replies", () => {
    expect(toProjects(null, null)).toEqual([]);
    expect(toProjects({ error: "x" }, "text")).toEqual([]);
    expect(toProjects([{ name: "no id" }, 3], { builds: [null] })).toEqual([]);
  });
});

describe("preview URLs", () => {
  it("prefers the live preview while coding, else the verified one", () => {
    expect(buildPreviewUrl({ live_preview_url: "https://live.example/", preview_url: "https://pv.example/" })).toBe("https://live.example/");
    expect(buildPreviewUrl({ preview_url: "https://pv.example/?t=1" })).toBe("https://pv.example/?t=1");
    expect(buildPreviewUrl({})).toBeNull();
  });

  it("only lets https (or local http) into the iframe", () => {
    expect(safePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(safePreviewUrl("data:text/html,hi")).toBeNull();
    expect(safePreviewUrl("http://pv.example/")).toBeNull();
    expect(safePreviewUrl("https://user:pass@pv.example/")).toBeNull();
    expect(safePreviewUrl("not a url")).toBeNull();
    expect(safePreviewUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
  });
});
