import { describe, expect, it } from "vitest";
import { appKindsFrom, chipIdeas, ideaProducts, kindAsIdea, kindsFromRoute, picksForKind } from "@/lib/new-app";
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

// The products published for US developers today, and ideas on the kinds that follow them.
const LIVE = [
  { id: "certificate-of-deposit", name: "Certificate of Deposit (CD)", productLine: "account_operations", category: "deposits", status: "published" },
  { id: "money-market-account", name: "Money Market Account", productLine: "account_operations", category: "deposits", status: "published" },
  { id: "401k", name: "401(k) Plan", productLine: "wealth", category: "retirement", status: "published" },
  { id: "ira", name: "Individual Retirement Account (IRA)", productLine: "wealth", category: "retirement", status: "published" },
  { id: "money-market-fund", name: "Money Market Fund", productLine: "wealth", category: "mutual_funds", status: "published" },
  { id: "tips", name: "Treasury Inflation-Protected Securities (TIPS)", productLine: "credit", category: "bonds", status: "published" },
  { id: "my-annuity", name: "My annuity", productLine: "insurance", category: "annuities", status: "draft" },
];
const LIVE_KINDS = {
  kinds: [
    { id: "savings-goals", title: "Savings goals", description: "Save toward goals.", product_lines: ["account_operations"], categories: ["deposits"], goal_template: "A savings goals app on a deposit account." },
    { id: "retirement-account", title: "Retirement account", description: "An IRA or a 401(k).", product_lines: ["wealth"], categories: ["retirement"], goal_template: "A retirement account app." },
    { id: "cash-reserve", title: "Cash reserve", description: "Account and fund.", product_lines: ["account_operations", "wealth"], categories: ["deposits", "mutual_funds"], goal_template: "A cash reserve app." },
    { id: "annuity-planner", title: "Annuity planner", description: "Nothing published yet.", product_lines: ["insurance"], goal_template: "An annuity planner app." },
  ],
};
const liveIdea = (id: string, kind: string, lines: string[], extra: Record<string, unknown> = {}) => ({ ...idea(id, kind, `The problem ${id} solves`, lines), ...extra });
const LIVE_IDEAS = {
  ideas: [
    liveIdea("emergency-fund", "savings-goals", ["account_operations"], { categories: ["deposits"], product_names: ["Money Market Account"] }),
    liveIdea("any-deposit", "savings-goals", ["account_operations"], { categories: ["deposits"] }),
    liveIdea("ira-catch-up", "retirement-account", ["wealth"], { categories: ["retirement"], product_names: ["Individual Retirement Account"] }),
    liveIdea("any-retirement", "retirement-account", ["wealth"], { categories: ["retirement"] }),
    liveIdea("idle-cash", "cash-reserve", ["account_operations", "wealth"], { categories: ["deposits", "mutual_funds"], product_names: ["Money Market Account", "Money Market Fund"] }),
    liveIdea("annuity-ladder", "annuity-planner", ["insurance"]),
  ],
};

describe("using an idea picks the published products it names", () => {
  const kinds = appKindsFrom(LIVE_KINDS, LIVE_IDEAS);
  const ideaById = (id: string) => kinds.flatMap((k) => k.ideas).find((i) => i.id === id)!;

  it("reads each idea's categories and product names, and each kind's categories", () => {
    expect(ideaById("emergency-fund")).toMatchObject({ categories: ["deposits"], productNames: ["Money Market Account"] });
    expect(ideaById("annuity-ladder").categories).toBeUndefined();
    expect(kinds.find((k) => k.id === "retirement-account")!.categories).toEqual(["retirement"]);
    expect(kindsFromRoute(JSON.parse(JSON.stringify({ kinds })))).toEqual(kinds);
  });

  it("picks the named products in the idea's lines and categories, every one it names", () => {
    expect(picksForKind(ideaById("emergency-fund"), LIVE, [])).toEqual(["money-market-account"]);
    expect(picksForKind(ideaById("any-deposit"), LIVE, [])).toEqual(["certificate-of-deposit", "money-market-account"]);
    expect(picksForKind(ideaById("ira-catch-up"), LIVE, [])).toEqual(["ira"]);
    // A retirement idea never picks the money market fund in the same line.
    expect(picksForKind(ideaById("any-retirement"), LIVE, [])).toEqual(["401k", "ira"]);
    expect(picksForKind(ideaById("idle-cash"), LIVE, [])).toEqual(["money-market-account", "money-market-fund"]);
    // A kind used as itself picks by its categories.
    expect(picksForKind(kindAsIdea(kinds.find((k) => k.id === "retirement-account")!), LIVE, [])).toEqual(["401k", "ira"]);
    // What's picked already stays, and isn't listed twice.
    expect(picksForKind(ideaById("idle-cash"), LIVE, ["tips", "money-market-account"])).toEqual(["tips", "money-market-account", "money-market-fund"]);
  });

  it("names that match nothing fall back to the categories; a product without a category counts as in them; drafts are never picked", () => {
    expect(ideaProducts({ productLines: ["account_operations"], categories: ["deposits"], productNames: ["Nothing like it"] }, LIVE).map((p) => p.id)).toEqual(["certificate-of-deposit", "money-market-account"]);
    expect(ideaProducts({ productLines: ["wealth"], categories: ["retirement"] }, [{ id: "old", name: "Old fund", productLine: "wealth" }]).map((p) => p.id)).toEqual(["old"]);
    expect(ideaProducts({ productLines: ["insurance"] }, LIVE)).toEqual([]);
  });

  it("an idea with no published product isn't a chip, once the products are known", () => {
    const shown = (products: typeof LIVE | null) => chipIdeas(kinds, 0.3, 6, products).map((c) => c.idea.id);
    expect(shown(LIVE)).not.toContain("annuity-ladder");
    expect(shown(LIVE).length).toBe(5);
    // Until they load, any idea may be a chip: the first of each kind's comes first, so one is the annuity idea.
    expect(shown(null)).toContain("annuity-ladder");
    expect(shown([])).toEqual([]);
  });
});
