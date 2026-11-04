import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FinancialProduct } from "./catalog.js";
import { deriveContract } from "./contract.js";
import { checkDefinition, DEFINITION_SCHEMA_PATH, projectCatalogue, toV1Composition, type Definition } from "./definition.js";
import { blockingComponents, productRegime } from "./regime.js";
import { normalizeModel } from "./regulatory.js";
import type { ProductRecord, Store, User } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });

// The regulator short name the catalogue cites: whoever's licence covers the lead component, else whoever
// supervises it, else what the product cited before.
async function leadRegulator(store: Store, record: ProductRecord, def: Definition, v1: ReturnType<typeof toV1Composition>, regime?: Awaited<ReturnType<typeof productRegime>>) {
  regime ??= await productRegime(store, { ...record, components: v1.components, parties: v1.parties });
  const lead = def.projection?.lead_component ?? def.components?.[0]?.key;
  const row = regime.regions.flatMap((r) => r.components).find((c) => c.key === lead);
  const regulatorId = row?.coverage.status === "covered" ? row.coverage.by[0].regulator_id : row?.supervised_by[0]?.regulator_id;
  if (!row || !regulatorId) return record.product.regulator;
  const ref = await store.referenceData(true);
  const reg = normalizeModel(ref.regions.find((r) => r.code === row.region)?.regulatory).regulators.find((r) => r.id === regulatorId);
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
      const regime = await productRegime(store, { ...record, components: v1.components, parties: v1.parties });
      return json({
        valid: true,
        ...check,
        publish_blockers: blockingComponents(regime, record.product.region),
        catalogue_record: projectCatalogue(def, await leadRegulator(store, record, def, v1, regime)),
        developer_contract: deriveContract(def, record.version),
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
