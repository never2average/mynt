import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coveringLicenses } from "./access.js";
import { deriveContract } from "./contract.js";
import { reassertCovenantPause } from "./covenants.js";
import { checkDefinition, definitionHash, type Definition } from "./definition.js";
import { rederiveProduct } from "./derived.js";
import { buildPins, driftDependents } from "./pins.js";
import { runProductTests } from "./product-tests.js";
import type { CheckStatus, PromotionCheck } from "./promotions.js";
import { blockingComponents, productRegime } from "./regime.js";
import { emitProductEvent } from "./runtime.js";
import { productStage, type ProductRecord, type ProductStage, type ProductVersion, type Store, type User } from "./store.js";
import { vendorBindingsOf, vendorServedActions, vendorStateOf } from "./vendors.js";

// A financial product's stage, the same three as an app's (promotions.ts): idea → staging → production, one step at
// a time, and back down.
//
// - idea: a draft (or an unpublished product). Only its firm sees it.
// - staging: test_product passed on it, and it is open to sandbox builds only: developers may pin it on an app in
//   Ideas or Staging (list_buildable_products with environment 'sandbox', create_app, update_app) and their builds
//   get it, but no production app may use it, and promote_app refuses an app that does.
// - production: published, in the catalogue, for production apps. What publishing needs is unchanged: a passing test
//   of what goes live, a definition that still checks out, a verified licence (the firm's own, or a licence provider's
//   sponsorship of every component it doesn't provide itself), and published underlying products.
//
// Every check is Mynt's own, from its records: the test report Mynt ran (test_product, re-fingerprinted here, so an
// edit since makes it stale), its licence and sponsorship records, the definition checked again now. Nothing an app
// or an agent reports counts. Every move is in the audit trail (product_promoted, product_demoted) with the checks it
// passed. Only staging is stored (products.stage); a published product is in production, anything else an idea.
//
// publish_product stays as it was: promotion to production, straight from an idea too, since production's checks
// include staging's. A published product's next version (create_product_version) goes live the same way, by a
// promotion to production while the product stays there.

const ORDER: ProductStage[] = ["idea", "staging", "production"];

export class ProductStageError extends Error {}

export interface ProductPromotionChecks {
  product_id: string;
  from_stage: ProductStage;
  to_stage: "staging" | "production";
  version: number; // the version that would go live (or that was tested): a pending draft version's, else the product's
  checks: PromotionCheck[];
  can_promote: boolean;
}

// What publishing reads, and its checks in the order publish_product has always refused in.
export interface PublishGate {
  draft: ProductVersion | undefined;
  data: ProductRecord["product"];
  checks: PromotionCheck[];
  // The first refusal exactly as publish_product words it (an error, and a definition's errors), or null.
  refusal: { error: string; errors?: string[] } | null;
  held: Awaited<ReturnType<typeof coveringLicenses>>;
  regime: Awaited<ReturnType<typeof productRegime>> | null;
}

const check = (id: string, label: string, status: CheckStatus, detail: string, fix?: PromotionCheck["fix"]): PromotionCheck => ({ id, label, status, detail, ...(fix ? { fix } : {}) });

// Staging's one check, and production's first: Mynt's own test report on exactly what would go live.
function testCheck(data: ProductRecord["product"], lastTest: ProductRecord["last_test"]): { check: PromotionCheck; refusal: string | null } {
  const label = "Latest test passed (test_product)";
  const fix = { label: "Run test_product", tool: "test_product" };
  if (!lastTest || lastTest.fingerprint !== runProductTests(data).fingerprint) {
    const refusal = "Product changed since its last test (or was never tested); run test_product first";
    return { check: check("tests_passed", label, "fail", refusal, fix), refusal };
  }
  if (!lastTest.passed) {
    const refusal = "Last test failed; fix the failing checks and run test_product again";
    return { check: check("tests_passed", label, "fail", refusal, fix), refusal };
  }
  return { check: check("tests_passed", label, "pass", "Mynt's disclosure, consistency and misleading-claim checks passed on this version"), refusal: null };
}

// Everything publish_product checks, computed in full (so the studio can show each one), refusing in its order.
export async function publishGate(store: Store, user: Pick<User, "entity_id">, record: ProductRecord): Promise<PublishGate> {
  const draft = await store.draftVersion(record.product.id);
  const data = draft?.data ?? record.product;
  const checks: PromotionCheck[] = [];
  const refusals: { error: string; errors?: string[] }[] = [];
  const t = testCheck(data, draft ? draft.last_test : record.last_test);
  checks.push(t.check);
  if (t.refusal) refusals.push({ error: t.refusal });
  // A v2 definition must still check out: its parties, licences, register links and GRC records can have changed
  // since it was saved.
  if (record.definition) {
    const c = await checkDefinition(store, record, record.definition as unknown as Definition);
    if (c.errors.length) {
      checks.push(check("definition", "Definition still checks out", "fail", `The product's definition no longer checks out: ${c.errors.join("; ")}`, { label: "Check the definition", tool: "check_product_definition" }));
      refusals.push({ error: "The product's definition no longer checks out", errors: c.errors });
    } else checks.push(check("definition", "Definition still checks out", "pass", "Its parties, licences, register links and GRC records check out"));
  }
  // A composed product needs every component it provides itself covered by its firm's verified licences (partners'
  // components by theirs, a sponsor's by its sponsorship); otherwise a licence for its category and action.
  let held: PublishGate["held"] = [];
  let regime: PublishGate["regime"] = null;
  const label = "Licensed: a verified licence or sponsorship covers it";
  if (record.components.length) {
    regime = await productRegime(store, record);
    const blocking = blockingComponents(regime, data.region);
    if (blocking.length) {
      const error = `Not ready: ${blocking.map((b) => `${b.key} (${b.primitive} ${b.action}, ${b.region}): ${b.reason}`).join("; ")}`;
      checks.push(check("licences", label, "fail", error, { label: "See licences", href: "/licences", tool: "request_sponsorship" }));
      refusals.push({ error });
    } else checks.push(check("licences", label, "pass", `Every component is covered (${regime.regions.map((r) => r.region).join(", ")})`));
  } else {
    held = await coveringLicenses(store, user.entity_id, data.region, data.category, record.action);
    if (!held.length) {
      const error = `Publishing needs a verified licence for ${record.action} of '${data.category}' in ${data.region}, held by your entity (see find_licenses, register_license), or a composition whose components your licences cover (set_product_composition)`;
      checks.push(check("licences", label, "fail", error, { label: "See licences", href: "/licences", tool: "register_license" }));
      refusals.push({ error });
    } else checks.push(check("licences", label, "pass", `Your entity holds ${held.map((h) => `${h.license_id} (${h.regulator_id}, ${h.registration_number})`).join(", ")}`));
  }
  if (record.underlying_product_ids.length) {
    const notLive: string[] = [];
    for (const u of record.underlying_product_ids) if ((await store.getProduct(u))?.status !== "published") notLive.push(u);
    if (notLive.length) {
      const error = `Underlying products aren't published: ${notLive.join(", ")}`;
      checks.push(check("underlying_published", "Underlying products in production", "fail", error));
      refusals.push({ error });
    } else checks.push(check("underlying_published", "Underlying products in production", "pass", `${record.underlying_product_ids.join(", ")} published`));
  }
  return { draft, data, checks, refusal: refusals[0] ?? null, held, regime };
}

// The checks for moving a product one step up to `to`.
export async function productPromotionChecks(store: Store, user: Pick<User, "entity_id">, record: ProductRecord, to: "staging" | "production"): Promise<ProductPromotionChecks> {
  const from = productStage(record);
  const draft = await store.draftVersion(record.product.id);
  // In production, a pending draft version is promoted in place: the product stays in production meanwhile.
  const nextVersion = from === "production" && to === "production" && draft;
  if (!nextVersion && ORDER.indexOf(to) !== ORDER.indexOf(from) + 1)
    throw new ProductStageError(
      from === to
        ? `The product is already in ${from}${from === "production" ? "; draft its next version with create_product_version" : ""}`
        : ORDER.indexOf(to) <= ORDER.indexOf(from)
          ? `The product is in ${from}; use demote_product to move it down`
          : `Promote one step at a time: the product is in ${from}, so its next stage is staging`,
    );
  if (to === "staging") {
    const data = draft?.data ?? record.product;
    const t = testCheck(data, draft ? draft.last_test : record.last_test);
    return { product_id: record.product.id, from_stage: from, to_stage: to, version: draft?.version ?? record.version, checks: [t.check], can_promote: !t.refusal };
  }
  const gate = await publishGate(store, user, record);
  return { product_id: record.product.id, from_stage: from, to_stage: to, version: gate.draft?.version ?? record.version, checks: gate.checks, can_promote: !gate.refusal };
}

// Publishing: what goes live (a pending draft version, else the product), its pins, events and what's derived from
// it. Callers have passed publishGate.
async function goLive(store: Store, record: ProductRecord, gate: PublishGate) {
  const id = record.product.id;
  const live = gate.draft ? await store.publishDraftVersion(id) : await store.publishCurrentVersion(id);
  // The live version's composition and everything it rests on are pinned; changes later pause sales.
  if (gate.regime) {
    const pins = await buildPins(store, record, live.version, gate.regime);
    if (record.definition) {
      pins.definition_hash = definitionHash(record.definition as unknown as Definition);
      const connections = ((record.definition as unknown as Definition).connections ?? []) as never;
      pins.contract = deriveContract(record.definition as unknown as Definition, live.version, await vendorServedActions(store, connections));
      const bindings = await vendorBindingsOf(store, connections);
      if (bindings.length) {
        pins.vendor_bindings = bindings;
        pins.state.vendors = {};
        for (const b of bindings) pins.state.vendors[b.subscription_id] = await vendorStateOf(store, b.subscription_id);
      }
    }
    await store.setPins(id, pins);
  } else await store.setPins(id, null);
  // A covenant's pause outlasts a new version: only the sponsor lifts it.
  await reassertCovenantPause(store, id);
  // Its coverage and take rate as published (never stops the publish; a failure is stored as a note).
  await rederiveProduct(store, id);
  await emitProductEvent(store, id, "product.version_published", { version: live.version });
  // Products built on this one drift if the new version is offered somewhere else.
  const drifted = await driftDependents(store, id);
  return { live, drifted };
}

// To production: publish_product's checks and effects, audited as a promotion. `via` names the tool.
export async function promoteToProduction(store: Store, user: Pick<User, "id" | "entity_id">, record: ProductRecord, gate: PublishGate, via: "promote_product" | "publish_product") {
  const from = productStage(record);
  const { live, drifted } = await goLive(store, record, gate);
  await store.audit(user.id, "product_promoted", record.product.id, {
    product_id: record.product.id,
    from_stage: from,
    to_stage: "production",
    version: live.version,
    via,
    checks: gate.checks,
  });
  return { live, drifted };
}

export async function promoteProduct(store: Store, user: Pick<User, "id" | "entity_id">, record: ProductRecord, to: "staging" | "production") {
  const result = await productPromotionChecks(store, user, record, to);
  if (!result.can_promote) {
    const blocking = result.checks.filter((c) => c.status === "fail" || c.status === "pending").map((c) => `${c.label}: ${c.detail}`);
    throw new ProductStageError(`Not promoted: ${blocking.join("; ")}. See get_product_promotion_checks`);
  }
  if (to === "staging") {
    const saved = await store.setProductStage(record.product.id, "staging");
    await store.audit(user.id, "product_promoted", record.product.id, { product_id: record.product.id, from_stage: result.from_stage, to_stage: "staging", version: result.version, via: "promote_product", checks: result.checks });
    return { promoted: true as const, ...result, stage: productStage(saved) };
  }
  // The checks again with everything publishing needs, then publishing itself.
  const gate = await publishGate(store, user, record);
  if (gate.refusal) throw new ProductStageError(`Not promoted: ${gate.refusal.error}. See get_product_promotion_checks`);
  const { live, drifted } = await promoteToProduction(store, user, record, gate, "promote_product");
  return {
    promoted: true as const,
    ...result,
    checks: gate.checks,
    stage: "production" as const,
    version: live.version,
    licensed_under: gate.held.map((h) => ({ regulator: h.regulator_id, license: h.license_id, registration_number: h.registration_number })),
    ...(drifted.length ? { drifted_products: drifted } : {}),
  };
}

// Down one step. Out of production the product leaves the catalogue as unpublish_product does (existing enrollments
// are kept, no new ones; products built on it pause their sales) and stays open to sandbox builds in staging.
export async function demoteProduct(store: Store, user: Pick<User, "id">, record: ProductRecord, to: "idea" | "staging", reason: string) {
  const id = record.product.id;
  const from = productStage(record);
  if (ORDER.indexOf(to) !== ORDER.indexOf(from) - 1)
    throw new ProductStageError(from === "idea" ? "The product is in idea, the first stage" : `Demote one step at a time: the product is in ${from}, so it goes down to ${ORDER[ORDER.indexOf(from) - 1]}`);
  let drifted: string[] = [];
  if (from === "production") {
    await store.setProductStatus(id, "unpublished");
    await store.setProductStage(id, "staging");
    await rederiveProduct(store, id);
    await emitProductEvent(store, id, "product.unpublished");
    drifted = await driftDependents(store, id);
  } else await store.setProductStage(id, null);
  await store.audit(user.id, "product_demoted", id, { product_id: id, from_stage: from, to_stage: to, reason, unpublished: from === "production" });
  return { product_id: id, from_stage: from, to_stage: to, reason, ...(from === "production" ? { unpublished: true } : {}), ...(drifted.length ? { drifted_products: drifted } : {}) };
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// `mine`: a product the caller may move (its owner's, or for an admin one of Mynt's reference products).
export function registerProductStageTools(server: McpServer, store: Store, user: User, mine: (id: string) => Promise<ProductRecord | undefined>) {
  const guard = async <T>(f: () => Promise<T>) => {
    try {
      return json(await f());
    } catch (e) {
      if (e instanceof ProductStageError) return fail(e.message);
      throw e;
    }
  };
  const TO = z.enum(["staging", "production"]);

  server.registerTool(
    "get_product_promotion_checks",
    {
      title: "What a product needs to move up a stage",
      description:
        "Innovator: the checks for promoting one of your financial products one step, idea → staging or staging → production (or a production product's pending draft version to production), the same stages as an app's, computed by Mynt from its own records. staging: test_product passed on what would go live, unchanged since. production: what publishing needs: that test, the v2 definition still checking out, a verified licence covering it (your firm's, or a licence provider's sponsorship of each component you don't provide yourself), and published underlying products. Each check is pass or fail with Mynt's detail and a fix; can_promote when all pass.",
      inputSchema: { product_id: z.string(), to_stage: TO },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id, to_stage }) => {
      const record = await mine(product_id);
      if (!record) return fail(`No product of yours with id '${product_id}'`);
      return guard(() => productPromotionChecks(store, user, record, to_stage));
    },
  );

  server.registerTool(
    "promote_product",
    {
      title: "Promote a financial product one stage",
      description:
        "Innovator: move one of your products up one stage, as apps move. idea → staging: test_product passed on it; it opens to sandbox builds only (developers may pin it on apps in Ideas or Staging; no production app may use it). staging → production: publishes it, with everything publish_product requires (a verified licence or sponsorship covering it); a production product's pending draft version goes live the same way. Mynt runs every check again at that moment and refuses unless all pass; the move and the checks it passed with are in the audit trail (product_promoted).",
      inputSchema: { product_id: z.string(), to_stage: TO },
    },
    async ({ product_id, to_stage }) => {
      const record = await mine(product_id);
      if (!record) return fail(`No product of yours with id '${product_id}'`);
      return guard(() => promoteProduct(store, user, record, to_stage));
    },
  );

  server.registerTool(
    "demote_product",
    {
      title: "Move a financial product down one stage",
      description:
        "Innovator: move one of your products down one stage (production → staging, staging → idea), with the reason, recorded in the audit trail (product_demoted). Out of production it leaves the catalogue as unpublish_product does (existing enrollments are kept, no new ones; products built on it pause their sales) and stays open to sandbox builds; out of staging, sandbox builds can no longer pick it.",
      inputSchema: { product_id: z.string(), to_stage: z.enum(["idea", "staging"]), reason: z.string().min(1).max(1000) },
    },
    async ({ product_id, to_stage, reason }) => {
      const record = await mine(product_id);
      if (!record) return fail(`No product of yours with id '${product_id}'`);
      return guard(() => demoteProduct(store, user, record, to_stage, reason));
    },
  );
}
