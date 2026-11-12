import { z } from "zod";
import { BuildTermsSchema, DEFAULT_PERMITTED, type ExperienceCheck } from "./access.js";
import type { App, ProductRecord } from "./store.js";

// Structured experiences: screens made of a fixed set of components, so Mynt can check them
// against each product's build terms before they go live.
export const HANDOFF_ACTIONS = ["deep_link", "initiate_onboarding"] as const;
export const CALCULATOR_KINDS = ["maturity", "emi", "sip"] as const;

const ComponentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("product_card"), product_id: z.string().min(1) }),
  z.object({ type: z.literal("comparison_table"), product_ids: z.array(z.string().min(1)).min(2) }),
  z.object({ type: z.literal("calculator"), product_id: z.string().min(1), kind: z.enum(CALCULATOR_KINDS) }),
  z.object({ type: z.literal("disclosure_block"), product_id: z.string().min(1) }),
  z.object({ type: z.literal("handoff_cta"), product_id: z.string().min(1), action: z.enum(HANDOFF_ACTIONS), label: z.string().min(1) }),
  z.object({ type: z.literal("text"), content: z.string().min(1) }),
]);

export const ScreenSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, '-' or '_'"),
  title: z.string().min(1),
  components: z.array(ComponentSchema).min(1),
});

export const ExperienceSchema = z
  .object({ screens: z.array(ScreenSchema).min(1).max(50) })
  .superRefine((e, ctx) => {
    const seen = new Set<string>();
    e.screens.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["screens", i, "id"], message: `Duplicate screen id '${s.id}'` });
      seen.add(s.id);
    });
  });

export type Experience = z.infer<typeof ExperienceSchema>;
export type Component = z.infer<typeof ComponentSchema>;

const termsOf = (p: ProductRecord) => ({ ...BuildTermsSchema.parse({}), ...p.build_terms });
const permittedOf = (p: ProductRecord) => {
  const t = p.build_terms?.permitted_actions;
  return t?.length ? t : DEFAULT_PERMITTED;
};

// Products a component shows (a disclosure block discloses rather than shows).
export function shownProducts(c: Component): string[] {
  switch (c.type) {
    case "product_card":
    case "calculator":
    case "handoff_cta":
      return [c.product_id];
    case "comparison_table":
      return c.product_ids;
    default:
      return [];
  }
}

const referenced = (c: Component): string[] => (c.type === "disclosure_block" ? [c.product_id] : shownProducts(c));
const copyOf = (c: Component): string[] => (c.type === "text" ? [c.content] : c.type === "handoff_cta" ? [c.label] : []);

// Text a disclosure_block renders for a product: its required disclosures, verbatim.
export const disclosureText = (p: ProductRecord) => termsOf(p).required_disclosures;

export interface StructureResult {
  defined: boolean;
  passed: boolean;
  checks: ExperienceCheck[];
  rendered_disclosures: string[];
}

// Structural checks of an experience against the app's products and their build terms.
// `products` are the app's published product records.
export function checkStructure(app: Pick<App, "product_ids">, experience: Experience | null, products: ProductRecord[]): StructureResult {
  if (!experience) return { defined: false, passed: true, checks: [], rendered_disclosures: [] };
  const checks: ExperienceCheck[] = [];
  const byId = new Map(products.map((p) => [p.product.id, p]));
  const add = (product_id: string, name: string, failures: string[], ok: string) =>
    checks.push(failures.length ? { product_id, name, status: "fail", message: failures.join("; ") } : { product_id, name, status: "pass", message: ok });

  // Components only reference products in the app.
  const outside = new Set<string>();
  for (const s of experience.screens) for (const c of s.components) for (const id of referenced(c)) if (!app.product_ids.includes(id)) outside.add(id);
  add("*", "component_products", [...outside].map((id) => `'${id}' is not one of this app's products`), "Components only use the app's products");

  const rendered: string[] = [];
  for (const id of app.product_ids) {
    const p = byId.get(id);
    if (!p) continue;
    const terms = termsOf(p);
    const permitted = permittedOf(p);

    // Every screen that shows the product also carries its disclosure block.
    const missingOn = experience.screens.filter(
      (s) => s.components.some((c) => shownProducts(c).includes(id)) && !s.components.some((c) => c.type === "disclosure_block" && c.product_id === id),
    );
    add(id, "screen_disclosures", missingOn.map((s) => `Screen '${s.id}' shows '${id}' without its disclosure_block`), "Every screen showing the product discloses it");

    // CTAs only hand off in ways the product permits; comparisons need 'compare'.
    const bad: string[] = [];
    for (const s of experience.screens)
      for (const c of s.components) {
        if (c.type === "handoff_cta" && c.product_id === id && !permitted.includes(c.action))
          bad.push(`Screen '${s.id}': '${id}' doesn't permit ${c.action} (permitted: ${permitted.join(", ")})`);
        if (c.type === "comparison_table" && c.product_ids.includes(id) && !permitted.includes("compare")) bad.push(`Screen '${s.id}': '${id}' doesn't permit compare`);
      }
    add(id, "component_actions", bad, "Components use only permitted actions");

    // Banned wording anywhere in the experience's copy.
    const copy = experience.screens.flatMap((s) => [s.title, ...s.components.flatMap(copyOf)]).join("\n").toLowerCase();
    const banned = terms.banned_phrases.filter((b) => copy.includes(b.toLowerCase()));
    add(id, "experience_banned_phrases", banned.length ? [`Uses banned wording: ${banned.join(", ")}`] : [], "No banned wording in the experience");

    // Required disclosures are rendered by a disclosure_block somewhere in the experience.
    const blocked = experience.screens.some((s) => s.components.some((c) => c.type === "disclosure_block" && c.product_id === id));
    if (blocked) rendered.push(...terms.required_disclosures);
    add(
      id,
      "disclosures_rendered",
      terms.required_disclosures.length && !blocked ? [`No disclosure_block renders the required disclosures of '${id}'`] : [],
      "Required disclosures are rendered",
    );
  }
  return { defined: true, passed: checks.every((c) => c.status === "pass"), checks, rendered_disclosures: rendered };
}

const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"'`]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[ch]!);

const CALCULATOR_LABEL: Record<(typeof CALCULATOR_KINDS)[number], string> = {
  maturity: "Maturity calculator: amount, rate and term give the value at maturity",
  emi: "EMI calculator: loan amount, rate and tenure give the monthly instalment",
  sip: "SIP calculator: monthly amount, expected return and years give the projected value",
};

// A self-contained HTML document for reviewing an experience: inline styles only, no scripts or
// external assets, and every value escaped.
export function renderPreview(
  app: Pick<App, "name" | "description">,
  experience: Experience,
  products: Map<string, { record: ProductRecord; issuer: string | null }>,
): string {
  const e = escapeHtml;
  const name = (id: string) => products.get(id)?.record.product.name ?? id;
  const unavailable = (id: string) => `<div class="card missing">Product ${e(id)} is not available to this app</div>`;
  const component = (c: Component): string => {
    switch (c.type) {
      case "text":
        return `<p class="text">${e(c.content)}</p>`;
      case "product_card": {
        const p = products.get(c.product_id);
        if (!p) return unavailable(c.product_id);
        const d = p.record.product;
        return `<div class="card"><h3>${e(d.name)}</h3><p class="meta">${e(d.product_line)} · ${e(d.category)} · ${e(d.region)} · risk ${e(d.risk_level)}</p><p>${e(d.description)}</p><ul>${d.key_features.map((f) => `<li>${e(f)}</li>`).join("")}</ul>${brand(p)}</div>`;
      }
      case "comparison_table": {
        const rows: [string, (p: ProductRecord) => unknown][] = [
          ["Product line", (p) => p.product.product_line],
          ["Risk", (p) => p.product.risk_level],
          ["Liquidity", (p) => p.product.liquidity],
          ["Horizon", (p) => p.product.typical_horizon],
          ["Returns", (p) => p.product.return_type],
          ["Regulator", (p) => p.product.regulator],
        ];
        const cols = c.product_ids.map((id) => products.get(id)?.record);
        return `<table><thead><tr><th></th>${c.product_ids.map((id) => `<th>${e(name(id))}</th>`).join("")}</tr></thead><tbody>${rows
          .map(([label, f]) => `<tr><th>${e(label)}</th>${cols.map((p) => `<td>${p ? e(f(p)) : "n/a"}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`;
      }
      case "calculator":
        return products.has(c.product_id)
          ? `<div class="calc"><h4>${e(name(c.product_id))}</h4><p>${e(CALCULATOR_LABEL[c.kind])}</p></div>`
          : unavailable(c.product_id);
      case "disclosure_block": {
        const p = products.get(c.product_id);
        if (!p) return unavailable(c.product_id);
        const lines = disclosureText(p.record);
        return `<aside class="disclosure"><strong>${e(p.record.product.name)}</strong>${lines.map((l) => `<p>${e(l)}</p>`).join("")}${brand(p)}</aside>`;
      }
      case "handoff_cta":
        return `<div class="cta"><span class="button">${e(c.label)}</span><small>${e(c.action === "deep_link" ? "Opens" : "Starts onboarding with")} ${e(name(c.product_id))}'s own flow</small></div>`;
    }
  };
  const brand = (p: { record: ProductRecord; issuer: string | null }) => {
    const b = termsOf(p.record).branding;
    const by = p.issuer ? `Offered by ${p.issuer}` : "";
    return b || by ? `<p class="brand">${e([by, b].filter(Boolean).join(". "))}</p>` : "";
  };
  const screens = experience.screens
    .map((s) => `<section id="screen-${e(s.id)}"><h2>${e(s.title)}</h2>${s.components.map(component).join("\n")}</section>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${e(app.name)} (preview)</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:720px;padding:16px;color:#1a1a1a;background:#fff}
section{border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0}
.card,.calc{border:1px solid #e3e3e3;border-radius:6px;padding:12px;margin:8px 0}
.missing{color:#a00}
.meta,.brand,small{color:#555;font-size:13px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;text-align:left}
.disclosure{background:#f6f6f6;border-left:3px solid #888;padding:8px 12px;margin:8px 0}
.button{display:inline-block;background:#1a1a1a;color:#fff;border-radius:6px;padding:8px 14px;margin-right:8px}
</style>
</head>
<body>
<header><h1>${e(app.name)}</h1><p>${e(app.description)}</p></header>
${screens}
</body>
</html>
`;
}
