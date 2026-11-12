import { z } from "zod";
import { licenseProducts, normalizeModel } from "./regulatory.js";
import type { App, BuildTerms, HeldLicense, ProductAction, ProductRecord, Store, User } from "./store.js";

// What a developer's experience may do with a product. Anything that moves money or collects KYC
// hands off to the innovator's own regulated flow; developers never hold funds or financial data.
export const EXPERIENCE_ACTIONS = ["display", "compare", "prefill", "deep_link", "embed_widget", "initiate_onboarding"] as const;
export const DEFAULT_PERMITTED: string[] = ["display", "compare", "deep_link"];

export const BuildTermsSchema = z.object({
  permitted_actions: z.array(z.enum(EXPERIENCE_ACTIONS)).default(DEFAULT_PERMITTED as never).describe("What experiences may do with the product"),
  required_disclosures: z.array(z.string().min(1)).default([]).describe("Text every experience must show, e.g. a risk warning"),
  banned_phrases: z.array(z.string().min(1)).default([]).describe("Words or claims experiences must not use"),
  allowed_personas: z.array(z.string()).default([]).describe("Customer persona ids the experience may target (empty: any the licence allows)"),
  branding: z.string().default("").describe("How the product and its issuer or distributor must be labelled"),
  commercials: z
    .object({
      model: z.enum(["none", "referral_fee", "revenue_share"]).default("none"),
      value: z.number().nonnegative().optional().describe("Fee amount or share percentage"),
      notes: z.string().optional(),
    })
    .default({ model: "none" }),
  handoff_url: z
    .url({ protocol: /^https$/ })
    .optional()
    .describe("Your onboarding entry point: runtime API hand-offs (deep_link, initiate_onboarding) redirect here with ?handoff_id=…&app_id=…"),
});

const today = () => new Date().toISOString().slice(0, 10);

// A verified licence is usable only inside its validity window.
export const licenseInForce = (l: HeldLicense, on = today()) =>
  l.status === "verified" && (!l.valid_from || l.valid_from <= on) && (!l.valid_to || l.valid_to >= on);

// Verified, in-force licences of `entityId` that permit `action` on a product's category in its region.
export async function coveringLicenses(store: Store, entityId: string | null, region: string, category: string, action: ProductAction) {
  if (!entityId) return [];
  const held = (await store.licensesOf(entityId)).filter((l) => l.region === region && licenseInForce(l));
  if (held.length === 0) return [];
  const regionRow = (await store.referenceData(true)).regions.find((r) => r.code === region);
  const model = normalizeModel(regionRow?.regulatory);
  return held.filter((h) => {
    const regulator = model.regulators.find((r) => r.id === h.regulator_id);
    const license = regulator?.license_types.find((l) => l._id === h.license_id);
    if (!regulator || !license) return false;
    // What the licence grants, not everything its regulator supervises.
    return licenseProducts(regulator, license).some((p) => p.type_id === category && (p.action as string[]).includes(action));
  });
}

// Whether a developer may build `app` on a product: their own or their entity's product, an open
// product, or an approved request for this app (or an invitation to them).
export async function accessStatus(store: Store, user: User, product: ProductRecord, appId: string | null) {
  if (product.owner_id === user.id || (user.entity_id && product.entity_id === user.entity_id)) return { granted: true, via: "own" as const };
  if (product.access_mode === "open") return { granted: true, via: "open" as const };
  const requests = (await store.requestsForProducts([product.product.id])).filter((r) => r.kind === "product_access" && r.requester_id === user.id);
  const forThis = requests.find((r) => r.app_id === appId || r.app_id === null);
  if (forThis?.status === "approved") return { granted: true, via: (forThis.app_id ? "approved" : "invited") as "approved" | "invited", request_id: forThis.id };
  return { granted: false, via: (forThis?.status ?? (product.access_mode === "private" ? "private" : "none")) as string, request_id: forThis?.id };
}

export interface ExperienceCheck {
  product_id: string;
  name: string;
  status: "pass" | "fail";
  message: string;
}

// An experience must stay inside every product's build terms.
export function lintExperience(app: Pick<App, "name" | "description" | "audience" | "disclosures" | "actions">, products: ProductRecord[]): {
  passed: boolean;
  checks: ExperienceCheck[];
} {
  const checks: ExperienceCheck[] = [];
  const shown = app.disclosures.join("\n").toLowerCase();
  const copy = [app.name, app.description, app.audience, ...app.disclosures].join("\n").toLowerCase();
  for (const p of products) {
    const id = p.product.id;
    const terms: BuildTerms = p.build_terms ?? {};
    const permitted = terms.permitted_actions?.length ? terms.permitted_actions : DEFAULT_PERMITTED;
    const extra = app.actions.filter((a) => !permitted.includes(a));
    checks.push(
      extra.length
        ? { product_id: id, name: "actions", status: "fail", message: `'${id}' doesn't permit: ${extra.join(", ")} (permitted: ${permitted.join(", ")})` }
        : { product_id: id, name: "actions", status: "pass", message: "Actions are within the product's terms" },
    );
    const missing = (terms.required_disclosures ?? []).filter((d) => !shown.includes(d.toLowerCase()));
    checks.push(
      missing.length
        ? { product_id: id, name: "disclosures", status: "fail", message: `Must show: ${missing.map((d) => `"${d}"`).join("; ")}` }
        : { product_id: id, name: "disclosures", status: "pass", message: "Required disclosures are shown" },
    );
    const banned = (terms.banned_phrases ?? []).filter((b) => copy.includes(b.toLowerCase()));
    checks.push(
      banned.length
        ? { product_id: id, name: "banned_phrases", status: "fail", message: `Uses banned wording: ${banned.join(", ")}` }
        : { product_id: id, name: "banned_phrases", status: "pass", message: "No banned wording" },
    );
  }
  return { passed: checks.every((c) => c.status === "pass"), checks };
}

// The entity that answers for a product (its owner's), for routing developers' requests.
export async function productEntity(store: Store, product: ProductRecord) {
  if (product.entity_id) return store.getEntity(product.entity_id);
  if (!product.owner_id) return undefined;
  const owner = await store.getUser(product.owner_id);
  return owner?.entity_id ? store.getEntity(owner.entity_id) : undefined;
}

// Products a user answers for as an innovator: their own, and their entity's.
export async function productsAnsweredBy(store: Store, user: User): Promise<ProductRecord[]> {
  const own = await store.productsByOwner(user.id);
  if (!user.entity_id) return own;
  const members = await store.entityMembers(user.entity_id);
  const all = (await Promise.all(members.map((m) => store.productsByOwner(m.id)))).flat();
  const byId = new Map([...own, ...all].map((p) => [p.product.id, p]));
  return [...byId.values()];
}
