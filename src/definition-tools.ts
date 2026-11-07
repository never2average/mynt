import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FinancialProduct } from "./catalog.js";
import { deriveContract } from "./contract.js";
import { vendorServedActions } from "./vendors.js";
import { checkDefinition, DEFINITION_SCHEMA_PATH, projectCatalogue, toV1Composition, underlyingOf, type Definition } from "./definition.js";
import { blockingComponents, productRegime } from "./regime.js";
import { rederiveProduct } from "./derived.js";
import { normalizeModel } from "./regulatory.js";
import type { ProductRecord, Store, User } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });

// The regulator short name the catalogue cites, from the lead component (projection.lead_component, else the first
// component), in this order:
//   1. the regulator of the held licence that covers it (a firm's product);
//   2. else a licensing regulator, one whose licence types grant the component's regulated product type and action:
//      first one whose licence type the definition's own register items cite (e.g. obligations it satisfies on
//      rbi_universal_bank), else the one with the most licence types granting it;
//   3. else a regulator that supervises it;
//   4. else what the product cited before.
// Ties go to the regulator listed first in the region's regulators (define_region), then by id. Never simply the
// first id alphabetically: a broad perimeter can include regulators (an IFSC banking unit, an exchange listing)
// that aren't the product's own.
async function leadRegulator(store: Store, record: ProductRecord, def: Definition, v1: ReturnType<typeof toV1Composition>, regime?: Awaited<ReturnType<typeof productRegime>>) {
  regime ??= await productRegime(store, { ...record, components: v1.components, parties: v1.parties, underlying_product_ids: underlyingOf(def, record) });
  const lead = def.projection?.lead_component ?? def.components?.[0]?.key;
  const row = regime.regions.flatMap((r) => r.components).find((c) => c.key === lead);
  if (!row) return record.product.regulator;
  const ref = await store.referenceData(true);
  const region = ref.regions.find((r) => r.code === row.region);
  const regulators = normalizeModel(region?.regulatory).regulators;
  const byId = new Map(regulators.map((r) => [r.id, r]));
  const listed = (id: string) => {
    const r = byId.get(id);
    const i = (region?.regulators ?? []).findIndex((n) => n === r?.short_name || n === r?.name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rank = (ids: string[], score: (id: string) => number = () => 0) =>
    [...new Set(ids)].sort((a, b) => score(b) - score(a) || listed(a) - listed(b) || a.localeCompare(b))[0];

  let regulatorId: string | undefined;
  if (row.coverage.status === "covered") regulatorId = row.coverage.by[0].regulator_id;
  if (!regulatorId && row.licences.length) {
    const granting = new Set(row.licences.map((l) => `${l.regulator_id}/${l.license_id}`));
    const cited = (def.connections ?? [])
      .map((c) => (c as { to?: { kind?: string; regulator_id?: string; license_type_id?: string } }).to)
      .filter((t) => t?.kind === "register_item" && granting.has(`${t.regulator_id}/${t.license_type_id}`))
      .map((t) => t!.regulator_id!);
    const grants = (id: string) => row.licences.filter((l) => l.regulator_id === id).length;
    regulatorId = cited.length ? rank(cited, (id) => cited.filter((x) => x === id).length) : rank(row.licences.map((l) => l.regulator_id), grants);
  }
  regulatorId ??= rank(row.supervised_by.map((s) => s.regulator_id));
  const reg = regulatorId ? byId.get(regulatorId) : undefined;
  return reg?.short_name ?? reg?.name ?? record.product.regulator;
}

export const DEFINITION_SCHEMA_URI = "mynt://schemas/financial-product.v2";

// Innovators define their own products; admins any product (Mynt's reference catalogue included).
export function registerDefinitionTools(server: McpServer, store: Store, user: User, opts: { admin: boolean }) {
  const editable = async (id: string) => {
    const record = await store.getProduct(id);
    return record && (opts.admin || record.owner_id === user.id) ? record : undefined;
  };

  // The schema the tools below check against, readable by the people (and their agents) who write
  // definitions: they work over MCP and can't open the repository.
  server.registerResource(
    "product-definition-schema",
    DEFINITION_SCHEMA_URI,
    { title: "Financial product definition (v2) JSON Schema", mimeType: "application/schema+json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json", text: readFileSync(DEFINITION_SCHEMA_PATH, "utf8") }] }),
  );

  server.registerTool(
    "check_product_definition",
    {
      title: "Check a v2 product definition",
      description:
        "Validate a v2 product definition (its JSON Schema is the resource mynt://schemas/financial-product.v2) without saving it: the JSON Schema; that every connection end resolves (components, segments, algorithms, risk models, handoffs, terms… and upstream: the owner's licences, roster parties, register personas and items, current GRC records); and the composition rules (allowed primitive × action at each end of funds, converts_into, guarantees, discovers_price_for and the other links; one provider per component; a handoff to each providing party; one primary risk model per algorithm; every risk model governed). Pass product_id to check it against that product's firm; a valid definition then also lists publish_blockers, what its regime would refuse at publish (an uncovered component, a mandated stakeholder missing or not bound to its component).",
      inputSchema: { definition: z.record(z.string(), z.unknown()), product_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ definition, product_id }) => {
      const record = product_id ? await editable(product_id) : null;
      if (product_id && !record) return fail(`No product of yours with id '${product_id}'`);
      const def = definition as unknown as Definition;
      const check = await checkDefinition(store, record ?? null, def);
      if (check.errors.length || !record) return json({ valid: check.errors.length === 0, ...check });
      // A valid definition can still be refused at publish by its regime (an uncovered component, a
      // mandated stakeholder missing or not bound to the component it serves): say so now.
      const v1 = toV1Composition(def);
      const regime = await productRegime(store, { ...record, components: v1.components, parties: v1.parties, underlying_product_ids: underlyingOf(def, record) });
      return json({
        valid: true,
        ...check,
        publish_blockers: blockingComponents(regime, record.product.region),
        catalogue_record: projectCatalogue(def, await leadRegulator(store, record, def, v1, regime)),
        developer_contract: deriveContract(def, record.version, await vendorServedActions(store, (def.connections ?? []) as never)),
      });
    },
  );

  server.registerTool(
    "set_product_definition",
    {
      title: "Define a product (v2)",
      description:
        "Innovator: save the full v2 definition of one of your products: its components (line × action) and the typed links between them, segments, algorithms, risk models, partner handoffs, terms, rates, fees, limits, servicing, lifecycle events, costs and connections. It's checked as check_product_definition does and refused with every error at once. Saving sets the product's composition and parties from it (so get_product_regime and the publish checks use it) and its catalogue record from the projection; on a live product it goes into the draft version. Then test_product and publish_product as usual.",
      inputSchema: { product_id: z.string(), definition: z.record(z.string(), z.unknown()), changelog: z.string().min(3).optional() },
    },
    async ({ product_id, definition, changelog }) => {
      const record = await editable(product_id);
      if (!record) return fail(`No product of yours with id '${product_id}'`);
      const def = definition as unknown as Definition;
      const check = await checkDefinition(store, record, def);
      if (check.errors.length) return fail("The definition can't be saved", { errors: check.errors, warnings: check.warnings });
      const v1 = toV1Composition(def);
      const catalogue: FinancialProduct = projectCatalogue(def, await leadRegulator(store, record, def, v1));
      await store.setDefinition(product_id, def as unknown as Record<string, unknown>);
      await store.setComposition(product_id, v1.components, v1.parties);
      // builds_on is the definition's own record of the products it rests on.
      if (def.builds_on) await store.setUnderlyingProducts(product_id, underlyingOf(def, record));
      let target: "product" | "draft_version";
      if (record.status === "published") {
        const draft = await store.draftVersion(product_id);
        if (draft) await store.saveDraftVersion(product_id, catalogue, changelog ?? draft.changelog);
        else await store.createDraftVersion(product_id, catalogue, changelog ?? "Definition updated");
        target = "draft_version";
      } else {
        await store.saveProduct(catalogue, "draft");
        target = "product";
      }
      await store.audit(user.id, "set_product_definition", product_id, { components: v1.components.length, connections: def.connections?.length ?? 0, target });
      await rederiveProduct(store, product_id);
      return json({ product_id, saved: true, catalogue_record: catalogue, applied_to: target, warnings: check.warnings, next: "test_product, then publish_product" });
    },
  );

  server.registerTool(
    "get_product_definition",
    {
      title: "A product's v2 definition",
      description: "Innovator: the saved v2 definition of one of your products (its working copy), with its current check result. Live products also show the definition hash pinned at publish.",
      inputSchema: { product_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      const record = await editable(product_id);
      if (!record) return fail(`No product of yours with id '${product_id}'`);
      if (!record.definition) return fail(`'${product_id}' has no v2 definition yet; set one with set_product_definition`);
      const check = await checkDefinition(store, record, record.definition as unknown as Definition);
      return json({ definition: record.definition, valid: check.errors.length === 0, ...check, live_definition_hash: record.pins?.definition_hash ?? null });
    },
  );
}
