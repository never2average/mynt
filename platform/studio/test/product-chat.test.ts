import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { asksForProduct, DRAFT_PRODUCT, draftFromResult, productChatContext, productCommandText, validateProductDraft, type ProductChoices } from "@/lib/product-chat";
import { NewProductRequest } from "@/lib/products";
import { STUDIO_TOOLS } from "@/lib/studio-tools";

// New app's Create product mode: which messages go to drafting, the draft's checks (the Create product
// sheet's rules and Mynt's choices), and the route on Ask AI's stack with a fake Mynt, model and sign-in.

const CHOICES: ProductChoices = {
  regions: [{ code: "US", name: "United States", regulators: ["FinCEN", "OCC"] }],
  categories: [
    { id: "deposits", name: "Deposits", productLines: ["account_operations"] },
    { id: "loans", name: "Loans", productLines: ["credit"] },
  ],
  buildable: [{ id: "p1", name: "Dollar account", productLine: "custody_settlement" }],
  mine: ["my-draft"],
};
const INPUT = {
  name: "Green Savings",
  product_line: "account_operations",
  category: "Deposits",
  region: "us",
  regulator: "occ",
  action: "issuance",
  risk_level: "low",
  liquidity: "high",
  typical_horizon: "short",
  return_type: "fixed_interest",
  description: "A savings account that rounds up card spend.",
  key_features: ["Round-ups", " "],
};

describe("routing to Create product", () => {
  it("/create-product with a description is that description; alone it is an empty one; anything else isn't the command", () => {
    expect(productCommandText("/create-product A high-yield savings account")).toBe("A high-yield savings account");
    expect(productCommandText("  /create-product  ")).toBe("");
    expect(productCommandText("/create-product")).toBe("");
    expect(productCommandText("/create-productx")).toBeNull();
    expect(productCommandText("/products")).toBeNull();
    expect(productCommandText("Create a product")).toBeNull();
  });

  it("suggests Create product only when the text clearly asks for a product, never for an app", () => {
    for (const t of ["Create a product for small business savings", "I want to offer a CD to members", "define a new financial product", "We'd like to launch a credit line", "set up my own product"]) expect(asksForProduct(t), t).toBe(true);
    for (const t of ["Create an app for my product", "A savings app with round-ups", "Build an app that offers savings goals", "I want to offer my users an app", "/create-product x", "", "Show my products"]) expect(asksForProduct(t), t).toBe(false);
  });
});

describe("a drafted product", () => {
  it("passes the sheet's own rules, with the region, regulator and category as the sheet names them and the id from the name", () => {
    const out = validateProductDraft(INPUT, CHOICES, "d1");
    expect(out).toEqual({
      draft: {
        id: "d1",
        request: { ...INPUT, id: "green-savings", category: "deposits", region: "US", regulator: "OCC", underlying_product_ids: [], key_features: ["Round-ups"] },
      },
    });
    if ("draft" in out) {
      expect(NewProductRequest.safeParse(out.draft.request).success).toBe(true);
      expect(STUDIO_TOOLS.create_product.safeParse(out.draft.request).success).toBe(true);
    }
  });

  it("is refused, saying what to fix, when it names something Mynt doesn't offer or misses a field", () => {
    const err = (over: Record<string, unknown>) => (validateProductDraft({ ...INPUT, ...over }, CHOICES, "d") as { error: string }).error;
    expect(err({ region: "CA" })).toBe("region must be one of: US.");
    expect(err({ regulator: "SEC" })).toBe("regulator must be one of US's: FinCEN, OCC.");
    expect(err({ category: "loans" })).toBe("category must be one listed for account_operations: deposits.");
    expect(err({ action: "sale", underlying_product_ids: [] })).toMatch(/^underlying_product_ids: Pick the products/);
    expect(err({ action: "sale", underlying_product_ids: ["someone-else"] })).toBe("underlying_product_ids must be published products from the context; not: someone-else.");
    expect(err({ risk_level: "spicy" })).toMatch(/^risk_level: /);
    expect(err({ description: "" })).toMatch(/^description: /);
    expect(err({ id: "Green_Savings" })).toMatch(/^id: Use a lowercase slug/);
    expect(err({ id: "my-draft" })).toBe("id 'my-draft' is already one of the user's products: choose another id.");
    // Sale of a published product is fine.
    expect(validateProductDraft({ ...INPUT, action: "sale", underlying_product_ids: ["p1"] }, CHOICES, "d")).toHaveProperty("draft.request.underlying_product_ids", ["p1"]);
  });

  it("comes back to the chat as the route's tool output, re-checked", () => {
    const ok = validateProductDraft(INPUT, CHOICES, "d1") as { draft: unknown };
    expect(draftFromResult({ ok: true, ...ok })).toEqual(ok);
    expect(draftFromResult({ ok: false, error: "region must be one of: US." })).toEqual({ error: "region must be one of: US." });
    expect(draftFromResult({ ok: true, draft: { id: "d", request: { name: "x" } } })).toBeNull();
    expect(draftFromResult(undefined)).toBeNull();
  });

  it("is chosen from the context's lists, given as JSON", () => {
    const text = productChatContext(CHOICES);
    const data = JSON.parse(text.split("\n")[1]);
    expect(data.regions).toEqual([{ code: "US", name: "United States", regulators: ["FinCEN", "OCC"] }]);
    expect(data.products_to_build_on).toEqual([{ id: "p1", name: "Dollar account", product_line: "custody_settlement" }]);
    expect(data.ids_already_used).toEqual(["my-draft"]);
  });
});

// ---- the route ----

type Step = { thinking?: string[]; text?: string; tool?: { name: string; input: Record<string, unknown> } };
const fake = {
  session: undefined as Session | undefined,
  steps: [] as Step[],
  requests: [] as { tools: { name: string }[]; system: { text: string }[]; messages: unknown[] }[],
  calls: [] as string[],
};
vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({ save: async () => true, wasTouched: () => false, count: async () => 1, claim: async () => async () => undefined }),
}));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: Object.keys(STUDIO_TOOLS).map((name) => ({ name, inputSchema: { type: "object" } })) }),
    callTool: async ({ name }: { name: string }) => {
      fake.calls.push(name);
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_regions") return ok([{ code: "US", name: "United States", regulators: ["FinCEN", "OCC"] }]);
      if (name === "list_product_categories") return ok([{ id: "deposits", name: "Deposits", product_lines: ["account_operations"] }]);
      if (name === "list_buildable_products") return ok([{ id: "p1", name: "Dollar account", product_line: "custody_settlement" }]);
      if (name === "list_my_products") return ok([{ id: "my-draft", name: "Mine", status: "draft" }]);
      return ok([]);
    },
    close: async () => undefined,
  }),
}));
vi.mock("@/lib/llm", () => ({
  askConfigured: () => true,
  askModel: () => "claude-opus-5-5",
  createLlm: () => ({
    stream: (params: { tools: { name: string }[]; system: { text: string }[]; messages: unknown[] }) => {
      fake.requests.push({ tools: params.tools, system: params.system, messages: structuredClone(params.messages) });
      const step = fake.steps.shift() ?? { text: "Done." };
      const on = new Map<string, ((v: never) => void)[]>();
      const emit = (name: string, v: unknown) => on.get(name)?.forEach((cb) => cb(v as never));
      return {
        on: (e: string, cb: (v: never) => void) => void on.set(e, [...(on.get(e) ?? []), cb]),
        finalMessage: async () => {
          if (step.thinking) {
            for (const t of step.thinking) emit("thinking", t);
            emit("contentBlock", { type: "thinking", thinking: step.thinking.join(""), signature: "sig" });
          }
          if (step.text) emit("text", step.text);
          const content: unknown[] = [];
          if (step.thinking) content.push({ type: "thinking", thinking: step.thinking.join(""), signature: "sig" });
          if (step.text) content.push({ type: "text", text: step.text });
          if (step.tool) content.push({ type: "tool_use", id: `call-${fake.requests.length}`, name: step.tool.name, input: step.tool.input });
          return { content, stop_reason: step.tool ? "tool_use" : "end_turn" };
        },
      };
    },
  }),
}));

const { POST } = await import("@/app/api/product-chat/route");
const as = (...roles: string[]) => {
  fake.session = { id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() } as Session;
};
const send = (text: string) =>
  POST(new Request("http://localhost:3000/api/product-chat", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text }] }] }) }));
async function chunks(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

describe("the product assistant's route", () => {
  beforeEach(() => {
    as("developer");
    fake.steps = [];
    fake.requests = [];
    fake.calls = [];
  });

  it("streams its reasoning and reply, drafts with draft_product only, and creates nothing", async () => {
    fake.steps = [{ thinking: ["Savings, US…"], tool: { name: DRAFT_PRODUCT, input: INPUT } }, { text: "The draft is in the chat." }];
    const out = await chunks(await send("/create-product A savings account that rounds up card spend"));
    expect(out.filter((c) => String(c.type).startsWith("reasoning")).map((c) => c.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"]);
    // Offered only its draft tool, never Mynt's (create_product least of all).
    expect(fake.requests[0].tools.map((t) => t.name)).toEqual([DRAFT_PRODUCT]);
    // The command is stripped: the model reads the description.
    expect(JSON.stringify(fake.requests[0].messages)).not.toContain("/create-product");
    expect(fake.requests[0].system[1].text).toContain('"regulators":["FinCEN","OCC"]');
    const output = out.find((c) => c.type === "tool-output-available")!.output as { ok: boolean; draft: { id: string; request: Record<string, unknown> } };
    expect(output.ok).toBe(true);
    expect(output.draft.request).toMatchObject({ id: "green-savings", region: "US", regulator: "OCC", category: "deposits" });
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.delta)).toEqual(["The draft is in the chat."]);
    expect(fake.calls.sort()).toEqual(["list_buildable_products", "list_my_products", "list_product_categories", "list_regions"]);
    expect(fake.calls).not.toContain("create_product");
  });

  it("sends a refused draft back to the model with what to fix, and shows the refusal", async () => {
    fake.steps = [{ tool: { name: DRAFT_PRODUCT, input: { ...INPUT, region: "CA" } } }, { text: "Which region?" }];
    const out = await chunks(await send("A savings account in Canada"));
    expect(out.find((c) => c.type === "tool-output-available")!.output).toEqual({ ok: false, error: "region must be one of: US." });
    const toolResult = JSON.stringify(fake.requests[1].messages.at(-1));
    expect(toolResult).toContain("Draft refused: region must be one of: US.");
    expect(toolResult).toContain('"is_error":true');
  });

  it("is for developers, from the studio's own origin", async () => {
    as("liquidity_provider");
    expect((await send("A savings account")).status).toBe(403);
    as("developer");
    const res = await POST(new Request("http://localhost:3000/api/product-chat", { method: "POST", headers: { origin: "http://localhost:9999" }, body: "{}" }));
    expect(res.status).toBe(403);
  });
});
