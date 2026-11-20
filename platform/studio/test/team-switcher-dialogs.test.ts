// The workspace switcher's dialogs (Create workspace, Invitations): a title and their content, no
// subtitle explaining them. Read from the source: opening a Radix dialog from a Radix menu loops
// jsdom's focus handling, so these dialogs aren't driven in a test browser here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "../components/team-switcher.tsx"), "utf8");

describe("the switcher's dialogs", () => {
  it("have no explanatory DialogDescription", () => {
    expect(src).not.toContain("DialogDescription");
    expect(src).not.toContain("keeps its own apps and members");
    expect(src).not.toContain("only if you accept");
  });

  it("keep their titles, and Create workspace still says when Mynt can't create one yet", () => {
    expect(src).toContain("<DialogTitle>Invitations</DialogTitle>");
    expect(src).toContain("<DialogTitle>Create workspace</DialogTitle>");
    expect(src).toMatch(/!supported && \([\s\S]*data-unavailable[\s\S]*next update/);
  });
});
