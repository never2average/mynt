import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PRODUCT_LINES, type FinancialProduct } from "./catalog.js";
import { productsAnsweredBy } from "./access.js";
import type { Campaign, SegmentCriteria, Store, User, Variant } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export const CHANNELS = ["email", "sms", "push", "in_app", "web", "partner"] as const;

// ---- segments ----------------------------------------------------------------------------------

type Facts = { user_id: string; product_id: string; product_line: string }[];

export function matchesSegment(userId: string, criteria: SegmentCriteria, facts: Facts): boolean {
  const mine = facts.filter((f) => f.user_id === userId);
  const products = new Set(mine.map((f) => f.product_id));
  const lines = new Set(mine.map((f) => f.product_line));
  if (criteria.enrolled_in?.length && !criteria.enrolled_in.some((p) => products.has(p))) return false;
  if (criteria.enrolled_in_lines?.length && !criteria.enrolled_in_lines.some((l) => lines.has(l))) return false;
  if (criteria.not_enrolled_in?.some((p) => products.has(p))) return false;
  return true;
}

async function audience(store: Store, criteria: SegmentCriteria | null): Promise<string[]> {
  const [users, facts] = await Promise.all([store.listUsers(), store.activeEnrollmentFacts()]);
  return users.filter((u) => !criteria || matchesSegment(u.id, criteria, facts)).map((u) => u.id);
}

// ---- compliance lint for marketing copy ----------------------------------------------------------

export interface LintCheck {
  variant: string | null;
  name: string;
  status: "pass" | "fail";
  message: string;
}

const GUARANTEE = /guarantee|assured|risk[- ]free|no risk|can'?t lose|sure[- ]shot/i;
const RISK_DISCLOSURE = /market risk|risk of loss|may lose|value can (go down|fall)|not guaranteed/i;
const CREDIT_DISCLOSURE = /interest|apr|fees?|charges?/i;
const GUARANTEED_RETURN_TYPES = ["fixed_interest", "guaranteed_income", "guaranteed_plus_bonus", "protection"];

export function lintCampaign(variants: Variant[], products: FinancialProduct[]): { passed: boolean; checks: LintCheck[] } {
  const checks: LintCheck[] = [];
  const marketLinked = products.filter((p) => p.return_type === "market_linked");
  const credit = products.filter((p) => p.product_line === "credit");
  const canClaimGuarantee = products.every((p) => GUARANTEED_RETURN_TYPES.includes(p.return_type));
  const keys = variants.map((v) => v.key);
  checks.push(
    new Set(keys).size === keys.length
      ? { variant: null, name: "variant_keys", status: "pass", message: "Variant keys are unique" }
      : { variant: null, name: "variant_keys", status: "fail", message: "Variant keys must be unique" },
  );
  for (const v of variants) {
    const text = `${v.headline} ${v.body} ${v.cta}`;
    const add = (name: string, ok: boolean, pass: string, failMsg: string) =>
      checks.push({ variant: v.key, name, status: ok ? "pass" : "fail", message: ok ? pass : failMsg });
    add("copy_present", [v.headline, v.body, v.cta].every((s) => s.trim().length > 0), "Headline, body and CTA present", "Headline, body and CTA are all required");
    add(
      "no_guarantee_claims",
      canClaimGuarantee || !GUARANTEE.test(text),
      "No guaranteed-return claims",
      `Copy promises guaranteed or risk-free returns, but ${products.filter((p) => !GUARANTEED_RETURN_TYPES.includes(p.return_type)).map((p) => p.id).join(", ")} can lose value`,
    );
    add(
      "risk_disclosure",
      marketLinked.length === 0 || RISK_DISCLOSURE.test(v.body),
      marketLinked.length ? "Market-risk disclosure present" : "No market-linked products",
      `Body must disclose market risk for ${marketLinked.map((p) => p.id).join(", ")} (e.g. "subject to market risks")`,
    );
    add(
      "credit_cost_disclosure",
      credit.length === 0 || CREDIT_DISCLOSURE.test(v.body),
      credit.length ? "Cost of credit disclosed" : "No credit products",
      `Body must mention interest, APR or fees for ${credit.map((p) => p.id).join(", ")}`,
    );
  }
  return { passed: checks.every((c) => c.status === "pass"), checks };
}

// Same user and campaign always get the same variant.
export function assignVariant(userId: string, campaign: Campaign): Variant {
  const n = createHash("sha256").update(`${campaign.id}:${userId}`).digest().readUInt32BE(0);
  return campaign.variants[n % campaign.variants.length];
}

// ---- tools -------------------------------------------------------------------------------------

const variantSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/, "Use a short key like 'a' or 'control'"),
  headline: z.string(),
  body: z.string(),
  cta: z.string(),
});
const criteriaSchema = {
  enrolled_in: z.array(z.string()).optional().describe("Consumers active in any of these product ids"),
  enrolled_in_lines: z.array(z.enum(PRODUCT_LINES)).optional().describe("Consumers active in any product of these lines"),
  not_enrolled_in: z.array(z.string()).optional().describe("Consumers active in none of these product ids (e.g. to cross-sell)"),
};

async function loadProducts(store: Store, ids: string[]) {
  const records = await Promise.all(ids.map((id) => store.getProduct(id)));
  return {
    missing: ids.filter((_, i) => records[i]?.status !== "published"),
    products: records.filter((r) => r?.status === "published").map((r) => r!.product),
  };
}

async function metrics(store: Store, c: Campaign) {
  const segment = c.segment_id ? await store.getSegment(c.segment_id) : undefined;
  const reach = (await audience(store, segment?.criteria ?? null)).length;
  const enrollments = await store.campaignEnrollments(c.id);
  return {
    campaign_id: c.id,
    status: c.status,
    audience_size: reach,
    enrollments: enrollments.length,
    conversion_rate: reach ? enrollments.length / reach : 0,
    by_variant: c.variants.map((v) => {
      const n = enrollments.filter((e) => e.variant === v.key).length;
      return { variant: v.key, enrollments: n };
    }),
    by_product: c.product_ids.map((id) => ({ product_id: id, enrollments: enrollments.filter((e) => e.product_id === id).length })),
  };
}

// Developer: GTM engineering around published products.
export function registerGtmTools(server: McpServer, store: Store, user: User) {
  const ownCampaign = async (id: string) => {
    const c = await store.getCampaign(id);
    return c && c.owner_id === user.id ? c : undefined;
  };

  server.registerTool(
    "create_segment",
    {
      title: "Create an audience segment",
      description: "Developer (GTM): define an audience from consumers' current enrollments, e.g. holders of a savings product without term insurance.",
      inputSchema: { name: z.string().min(1), ...criteriaSchema },
    },
    async ({ name, ...criteria }) => {
      const segment = await store.createSegment(user.id, name, criteria);
      return json({ ...segment, audience_size: (await audience(store, criteria)).length });
    },
  );

  server.registerTool(
    "list_my_segments",
    {
      title: "List my segments",
      description: "Developer (GTM): your segments with their current audience size.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json(await Promise.all((await store.segmentsByOwner(user.id)).map(async (s) => ({ ...s, audience_size: (await audience(store, s.criteria)).length })))),
  );

  server.registerTool(
    "create_campaign",
    {
      title: "Create a campaign",
      description:
        "Developer (GTM): a draft go-to-market campaign for published products, aimed at a segment (or everyone), on chosen channels, with one or more copy variants for A/B testing. Lint, then launch.",
      inputSchema: {
        name: z.string().min(1),
        product_ids: z.array(z.string()).min(1),
        segment_id: z.string().optional().describe("Omit to target every consumer"),
        channels: z.array(z.enum(CHANNELS)).min(1),
        variants: z.array(variantSchema).min(1).max(5),
      },
    },
    async ({ segment_id, ...fields }) => {
      const { missing } = await loadProducts(store, fields.product_ids);
      if (missing.length) return fail(`Products not available: ${missing.join(", ")}`);
      if (segment_id && (await store.getSegment(segment_id))?.owner_id !== user.id) return fail(`No segment of yours with id '${segment_id}'`);
      return json(await store.createCampaign(user.id, { ...fields, segment_id: segment_id ?? null }));
    },
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Update a campaign",
      description: "Developer (GTM): change a draft or paused campaign. Only fields you pass change; lint again before launching.",
      inputSchema: {
        campaign_id: z.string(),
        name: z.string().min(1).optional(),
        product_ids: z.array(z.string()).min(1).optional(),
        segment_id: z.string().nullable().optional(),
        channels: z.array(z.enum(CHANNELS)).min(1).optional(),
        variants: z.array(variantSchema).min(1).max(5).optional(),
      },
    },
    async ({ campaign_id, ...changes }) => {
      const c = await ownCampaign(campaign_id);
      if (!c) return fail(`No campaign of yours with id '${campaign_id}'`);
      if (c.status === "live" || c.status === "ended" || c.status === "pending_approval")
        return fail(`A ${c.status.replace("_", " ")} campaign can't be edited${c.status === "live" ? "; pause it first" : ""}`);
      if (changes.product_ids) {
        const { missing } = await loadProducts(store, changes.product_ids);
        if (missing.length) return fail(`Products not available: ${missing.join(", ")}`);
      }
      if (changes.segment_id && (await store.getSegment(changes.segment_id))?.owner_id !== user.id)
        return fail(`No segment of yours with id '${changes.segment_id}'`);
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return json(await store.saveCampaign({ ...c, ...defined, last_lint: null } as Campaign));
    },
  );

  server.registerTool(
    "lint_campaign",
    {
      title: "Check campaign copy for compliance",
      description:
        "Developer (GTM): check every variant's copy against its products: no guaranteed-return claims for products that can lose value, market-risk disclosure for market-linked products, cost disclosure for credit.",
      inputSchema: { campaign_id: z.string() },
    },
    async ({ campaign_id }) => {
      const c = await ownCampaign(campaign_id);
      if (!c) return fail(`No campaign of yours with id '${campaign_id}'`);
      const { products, missing } = await loadProducts(store, c.product_ids);
      const report = { ...lintCampaign(c.variants, products), unavailable_products: missing };
      if (missing.length) report.passed = false;
      await store.saveCampaign({ ...c, last_lint: report });
      return json(report);
    },
  );

  server.registerTool(
    "launch_campaign",
    {
      title: "Launch a campaign",
      description:
        "GTM: go live. Consumers in the segment see it in list_offers. Its copy must pass the compliance lint. Promoting a financial product is a regulated act, so a campaign over other innovators' products waits for each of them to approve it (they see it in their requests inbox).",
      inputSchema: { campaign_id: z.string() },
    },
    async ({ campaign_id }) => {
      const c = await ownCampaign(campaign_id);
      if (!c) return fail(`No campaign of yours with id '${campaign_id}'`);
      if (c.status === "live" || c.status === "ended" || c.status === "pending_approval") return fail(`Campaign is already ${c.status}`);
      const { products, missing } = await loadProducts(store, c.product_ids);
      if (missing.length) return fail(`Cannot launch: products not available: ${missing.join(", ")}`);
      const report = lintCampaign(c.variants, products);
      if (!report.passed) return { ...json({ error: "Cannot launch: the copy fails the compliance lint", ...report }), isError: true };
      // Your own (or your entity's) products and the open reference catalogue need no approval.
      const yours = new Set((await productsAnsweredBy(store, user)).map((p) => p.product.id));
      const needApproval = [];
      for (const id of c.product_ids) {
        const record = await store.getProduct(id);
        if (record?.owner_id && !yours.has(id)) needApproval.push(id);
      }
      if (needApproval.length === 0) return json(await store.saveCampaign({ ...c, status: "live", last_lint: report }));
      const existing = await store.requestsForCampaign(c.id);
      for (const product_id of needApproval) {
        if (existing.some((r) => r.product_id === product_id && r.status === "pending")) continue;
        await store.createRequest({ kind: "campaign_launch", product_id, app_id: null, campaign_id: c.id, requester_id: user.id, status: "pending", note: c.name });
      }
      return json({ ...(await store.saveCampaign({ ...c, status: "pending_approval", last_lint: report })), awaiting_approval_for: needApproval });
    },
  );

  for (const [name, status, title] of [
    ["pause_campaign", "paused", "Pause a campaign"],
    ["end_campaign", "ended", "End a campaign"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `Developer (GTM): ${status === "paused" ? "stop showing a live campaign for now (launch it again later)" : "stop a campaign for good; its metrics stay"}.`,
        inputSchema: { campaign_id: z.string() },
      },
      async ({ campaign_id }) => {
        const c = await ownCampaign(campaign_id);
        if (!c) return fail(`No campaign of yours with id '${campaign_id}'`);
        if (status === "paused" && c.status !== "live") return fail("Only a live campaign can be paused");
        if (c.status === "ended") return fail("Campaign has already ended");
        return json(await store.saveCampaign({ ...c, status }));
      },
    );
  }

  server.registerTool(
    "list_my_campaigns",
    {
      title: "List my campaigns",
      description: "Developer (GTM): your campaigns, drafts included.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await store.campaignsByOwner(user.id)),
  );

  server.registerTool(
    "get_campaign_metrics",
    {
      title: "Campaign metrics",
      description: "Developer (GTM): audience size, attributed enrollments, conversion rate, and enrollments per variant and per product.",
      inputSchema: { campaign_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ campaign_id }) => {
      const c = await ownCampaign(campaign_id);
      return c ? json(await metrics(store, c)) : fail(`No campaign of yours with id '${campaign_id}'`);
    },
  );
}

// Consumer: live offers aimed at them, and enrolling through one.
export async function offersFor(store: Store, user: User) {
  const facts = await store.activeEnrollmentFacts();
  const out = [];
  for (const c of await store.liveCampaigns()) {
    const segment = c.segment_id ? await store.getSegment(c.segment_id) : undefined;
    if (segment && !matchesSegment(user.id, segment.criteria, facts)) continue;
    const { products } = await loadProducts(store, c.product_ids);
    if (!products.length) continue;
    const v = assignVariant(user.id, c);
    out.push({ campaign_id: c.id, headline: v.headline, body: v.body, cta: v.cta, products });
  }
  return out;
}

export async function attributionFor(store: Store, user: User, campaignId: string, productId: string) {
  const offer = (await offersFor(store, user)).find((o) => o.campaign_id === campaignId);
  if (!offer) return { error: `No live offer '${campaignId}' for you` } as const;
  if (!offer.products.some((p) => p.id === productId)) return { error: `Offer '${campaignId}' is not for '${productId}'` } as const;
  const campaign = (await store.getCampaign(campaignId))!;
  return { campaign_id: campaignId, variant: assignVariant(user.id, campaign).key } as const;
}
