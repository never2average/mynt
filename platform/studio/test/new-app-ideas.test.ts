import { describe, expect, it } from "vitest";
import { appKindsFrom, chipIdeas, ideaProducts, kindAsIdea, kindsFromRoute, picksForKind } from "@/lib/new-app";
import { chipProductIdeas, productIdeaMessage, productIdeaPrefill, productIdeasFrom, productIdeasFromRoute } from "@/lib/product-ideas";
import { NewProductRequest } from "@/lib/products";
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

// Financial product mode's ideas: new products a firm could define, from Mynt's database (list_product_ideas).
const pidea = (id: string, line: string, category: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: `People who need ${id}`,
  product_name: `Product ${id}`,
  summary: `What ${id} is, factually.`,
  product_line: line,
  category,
  region: "US",
  key_features: [`First feature of ${id}`, `Second feature of ${id}`],
  risk_level: "low",
  liquidity: "moderate",
  typical_horizon: "short",
  return_type: "fixed_interest",
  ...extra,
});
const PRODUCT_IDEAS = {
  ideas: [
    pidea("no-penalty-cd", "account_operations", "deposits"),
    pidea("rate-reset-cd", "account_operations", "deposits"),
    pidea("dual-approval-mma", "account_operations", "deposits"),
    pidea("catch-up-ira", "wealth", "retirement"),
    pidea("payday-ira", "wealth", "retirement"),
    pidea("sweep-mmf", "wealth", "mutual_funds"),
    pidea("tips-ladder", "credit", "bonds"),
    pidea("tips-gift", "credit", "bonds", { risk_level: "nonsense" }),
    // Not shown: no label, a line that isn't one, a bad id.
    pidea("no-label", "credit", "bonds", { label: "" }),
    pidea("off-line", "groceries", "bonds"),
    pidea("Bad Id", "credit", "bonds"),
  ],
};

describe("Financial product ideas", () => {
  it("are list_product_ideas' rows in the studio's shape, dropping the malformed, and survive the route", () => {
    const ideas = productIdeasFrom(PRODUCT_IDEAS);
    expect(ideas.map((i) => i.id)).toEqual(["no-penalty-cd", "rate-reset-cd", "dual-approval-mma", "catch-up-ira", "payday-ira", "sweep-mmf", "tips-ladder", "tips-gift"]);
    expect(ideas[0]).toEqual({
      id: "no-penalty-cd",
      label: "People who need no-penalty-cd",
      productName: "Product no-penalty-cd",
      summary: "What no-penalty-cd is, factually.",
      productLine: "account_operations",
      category: "deposits",
      region: "US",
      keyFeatures: ["First feature of no-penalty-cd", "Second feature of no-penalty-cd"],
      riskLevel: "low",
      liquidity: "moderate",
      typicalHorizon: "short",
      returnType: "fixed_interest",
    });
    expect(ideas.find((i) => i.id === "tips-gift")).not.toHaveProperty("riskLevel");
    expect(productIdeasFromRoute(JSON.parse(JSON.stringify({ kinds: [], productIdeas: ideas })))).toEqual(ideas);
    expect(productIdeasFrom(null)).toEqual([]);
    expect(productIdeasFromRoute({ kinds: [] })).toEqual([]);
  });

  it("six chips per seed, one from every product line first, the same for the same seed", () => {
    const ideas = productIdeasFrom(PRODUCT_IDEAS);
    for (const seed of [0, 0.25, 0.5, 0.99]) {
      const chips = chipProductIdeas(ideas, seed);
      expect(chips).toHaveLength(6);
      expect(new Set(chips.map((c) => c.id)).size).toBe(6);
      expect(new Set(chips.slice(0, 3).map((c) => c.productLine))).toEqual(new Set(["account_operations", "wealth", "credit"]));
      expect(chipProductIdeas(ideas, seed)).toEqual(chips);
    }
    expect(chipProductIdeas([], 0.5)).toEqual([]);
  });

  it("a chip's first message asks to define the named product, with the problem it answers, where, and its features", () => {
    const [idea] = productIdeasFrom(PRODUCT_IDEAS);
    const message = productIdeaMessage(idea);
    expect(message.startsWith("Help me define Product no-penalty-cd.")).toBe(true);
    expect(message).toContain("The problem it answers: People who need no-penalty-cd.");
    expect(message).toContain("What no-penalty-cd is, factually.");
    expect(message).toContain("US, account operations, deposits");
    expect(message).toContain("- Second feature of no-penalty-cd");
  });

  it("Use's prefill is the sheet's request but for the regulator, which the firm picks", () => {
    const [idea] = productIdeasFrom(PRODUCT_IDEAS);
    const prefill = productIdeaPrefill(idea);
    expect(prefill).toMatchObject({ id: "product-no-penalty-cd", name: "Product no-penalty-cd", product_line: "account_operations", category: "deposits", region: "US", action: "issuance", description: "What no-penalty-cd is, factually.", key_features: idea.keyFeatures, risk_level: "low", return_type: "fixed_interest" });
    expect(prefill).not.toHaveProperty("regulator");
    expect(NewProductRequest.safeParse({ ...prefill, regulator: "OCC" }).success).toBe(true);
  });

  it("list_product_ideas is a read the studio may call", () => {
    expect(parseStudioCall("list_product_ideas", {})).toEqual({ tool: "list_product_ideas", args: {} });
    expect(parseStudioCall("list_product_ideas", { product_line: "credit" })).toEqual({ tool: "list_product_ideas", args: { product_line: "credit" } });
    expect(parseStudioCall("list_product_ideas", { include_retired: true })).toHaveProperty("error");
  });
});
