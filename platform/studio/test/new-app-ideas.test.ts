import { describe, expect, it } from "vitest";
import { appKindsFrom, chipIdeas, kindsFromRoute } from "@/lib/new-app";
import { parseStudioCall } from "@/lib/studio-tools";

// New app's ideas come from Mynt's database (list_app_ideas), each under the kind it names; the kinds from list_app_kinds.
const KINDS = {
  kinds: [
    { id: "money-transfers", title: "Money transfers", description: "Move dollars.", product_lines: ["payments"], goal_template: "A money transfers app. Customers move dollars in and out." },
    { id: "savings-goals", title: "Savings goals", description: "Save toward goals.", product_lines: ["custody_settlement"], goal_template: "A savings goals app. Customers set goals and add money." },
  ],
};
const idea = (id: string, kind: string, problem: string, lines: string[]) => ({ id, kind, problem, pitch: `Pitch of ${id}.`, goal: `The goal of ${id}, to start from and edit.`, product_lines: lines });
const IDEAS = {
  ideas: [
    idea("trip-kitty", "money-transfers", "Friends on a trip lose track of who owes whom", ["payments"]),
    idea("creator-tip-jar", "money-transfers", "Fans have no simple way to send a creator a few dollars", ["payments"]),
    idea("rent-ready-streak", "savings-goals", "Renters scramble to find the full rent when it falls due", ["custody_settlement"]),
    // Not shown: a line its kind doesn't have, a kind that isn't there, no problem label.
    idea("off-line", "savings-goals", "Someone needs a line the kind doesn't have", ["payments"]),
    idea("no-kind", "nope", "Nobody can build this one", ["payments"]),
    { ...idea("no-label", "savings-goals", "", ["custody_settlement"]) },
  ],
};

describe("New app's ideas", () => {
  it("are list_app_ideas' rows, each under the kind it names, labelled by its problem", () => {
    const kinds = appKindsFrom(KINDS, IDEAS);
    expect(kinds.map((k) => [k.id, k.ideas.map((i) => i.id)])).toEqual([
      ["money-transfers", ["trip-kitty", "creator-tip-jar"]],
      ["savings-goals", ["rent-ready-streak"]],
    ]);
    expect(kinds[0].ideas[0]).toEqual({ id: "trip-kitty", problem: "Friends on a trip lose track of who owes whom", pitch: "Pitch of trip-kitty.", goal: "The goal of trip-kitty, to start from and edit.", productLines: ["payments"] });
    // The route's answer reads back the same.
    expect(kindsFromRoute(JSON.parse(JSON.stringify({ kinds })))).toEqual(kinds);
  });

  it("a Mynt without list_app_ideas, or with none yet, gives the kinds alone, and no idea chips", () => {
    for (const ideas of [null, { ideas: [] }, { note: "No ideas yet" }]) {
      const kinds = appKindsFrom(KINDS, ideas);
      expect(kinds.map((k) => k.ideas.length)).toEqual([0, 0]);
      expect(chipIdeas(kinds, 0.5)).toEqual([]);
    }
  });

  it("chips: at most six, one per kind first, the same for the same seed", () => {
    const kinds = appKindsFrom(KINDS, IDEAS);
    const chips = chipIdeas(kinds, 0.42);
    expect(chips.length).toBe(3);
    expect(new Set(chips.slice(0, 2).map((c) => c.kind.id))).toEqual(new Set(["money-transfers", "savings-goals"]));
    expect(chipIdeas(kinds, 0.42)).toEqual(chips);
  });

  it("the studio may read ideas (optionally one kind's) and nothing else about them", () => {
    expect(parseStudioCall("list_app_ideas", {})).toEqual({ tool: "list_app_ideas", args: {} });
    expect(parseStudioCall("list_app_ideas", { kind: "savings-goals" })).toEqual({ tool: "list_app_ideas", args: { kind: "savings-goals" } });
    expect(parseStudioCall("list_app_ideas", { include_retired: true })).toHaveProperty("error");
    for (const t of ["create_app_idea", "update_app_idea", "retire_app_idea", "seed_app_ideas"]) expect(parseStudioCall(t, { id: "trip-kitty" })).toHaveProperty("error");
  });
});
