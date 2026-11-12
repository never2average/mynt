import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessStatus } from "./access.js";
import type { DeveloperContract } from "./contract.js";
import { DATA_DICTIONARY } from "./data-dictionary.js";
import { checkJourney, defaultJourney, JourneySchema, previewJourney, type Journey } from "./journeys.js";
import type { Store, User } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });

// Developers: journeys built on products' developer contracts.
export function registerJourneyTools(server: McpServer, store: Store, user: User) {
  // The live contract of a product this developer may build on.
  const contractFor = async (productId: string): Promise<DeveloperContract | string> => {
    const record = await store.getProduct(productId);
    if (record?.status !== "published") return `No published product '${productId}'`;
    if (record.access_mode === "private" && !(await accessStatus(store, user, record, null)).granted) return `'${productId}' is private; ask its innovator for an invitation`;
    return record.pins?.contract ?? `'${productId}' has no developer contract yet (published without a v2 definition)`;
  };
  const parse = (journey: unknown): Journey | string => {
    const r = JourneySchema.safeParse(journey);
    return r.success ? r.data : r.error.issues.map((i) => `${i.path.join(".") || "journey"}: ${i.message}`).join("; ");
  };

  server.registerTool(
    "get_data_dictionary",
    {
      title: "Mynt's data dictionary",
      description: "Developer: the customer data fields journeys collect, with their type, validation, sensitivity (sensitive ones need a secure capture) and the ways each may be captured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(DATA_DICTIONARY),
  );

  server.registerTool(
    "get_default_journey",
    {
      title: "A product's default journey",
      description:
        "Developer: the minimum compliant journey for a product, built from its live developer contract: its offers and documents, each consent, the fields each hosted action needs (sensitive ones in secure inputs), the provider's hosted flows, then done. Start from it and edit (check_journey, save_journey).",
      inputSchema: { product_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      const contract = await contractFor(product_id);
      if (typeof contract === "string") return fail(contract);
      const journey = defaultJourney(contract);
      return json({ journey, check: checkJourney(journey, contract) });
    },
  );

  server.registerTool(
    "check_journey",
    {
      title: "Check a journey",
      description:
        "Developer: check a journey spec against its product's live developer contract, on every path: consent before personal data, the product's documents before any hosted action, every field an action needs collected before it and none it doesn't need, sensitive fields only in secure inputs, every step reachable and every path ending. Errors name the step and the fix; paths lists every route through it for simulation.",
      inputSchema: { journey: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    async ({ journey }) => {
      const j = parse(journey);
      if (typeof j === "string") return fail("The journey doesn't match the spec", { errors: [j] });
      const contract = await contractFor(j.built_on.product_id);
      if (typeof contract === "string") return fail(contract);
      return json(checkJourney(j, contract));
    },
  );

  server.registerTool(
    "preview_journey",
    {
      title: "Preview a journey",
      description: "Developer: a static HTML outline of a journey (each step, what it shows or does, and where it goes) for review.",
      inputSchema: { journey: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    async ({ journey }) => {
      const j = parse(journey);
      if (typeof j === "string") return fail("The journey doesn't match the spec", { errors: [j] });
      const contract = await contractFor(j.built_on.product_id);
      if (typeof contract === "string") return fail(contract);
      return { content: [{ type: "text" as const, text: previewJourney(j, contract) }] };
    },
  );

  server.registerTool(
    "save_journey",
    {
      title: "Save a journey to an app",
      description:
        "Developer: save a checked journey to one of your apps (its product must be one of the app's). Devices fetch it with GET /v1/client/journeys/{journey}. It's tied to the contract version it was checked against: when the product publishes a new contract, the journey stops being served until you check and save it again.",
      inputSchema: { app_id: z.string(), journey: z.record(z.string(), z.unknown()) },
    },
    async ({ app_id, journey }) => {
      const app = await store.getApp(app_id);
      if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
      const j = parse(journey);
      if (typeof j === "string") return fail("The journey doesn't match the spec", { errors: [j] });
      if (!app.product_ids.includes(j.built_on.product_id)) return fail(`'${j.built_on.product_id}' isn't one of this app's products`);
      const contract = await contractFor(j.built_on.product_id);
      if (typeof contract === "string") return fail(contract);
      const check = checkJourney(j, contract);
      if (!check.valid) return fail("The journey doesn't pass its checks", { errors: check.errors, warnings: check.warnings });
      const saved = await store.saveJourney({ app_id, journey_id: j.journey, product_id: j.built_on.product_id, contract_hash: contract.contract_hash, spec: j as unknown as Record<string, unknown> });
      await store.audit(user.id, "save_journey", `${app_id}/${j.journey}`, { product_id: j.built_on.product_id, contract_version: contract.version });
      return json({ ...saved, warnings: check.warnings, paths: check.paths.length });
    },
  );

  server.registerTool(
    "list_journeys",
    {
      title: "An app's journeys",
      description: "Developer: the journeys saved to one of your apps, and whether each is still current (built on its product's live contract).",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const app = await store.getApp(app_id);
      if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
      const out = [];
      for (const j of await store.journeysOf(app_id)) {
        const live = (await store.getProduct(j.product_id))?.pins?.contract?.contract_hash ?? null;
        out.push({ journey_id: j.journey_id, product_id: j.product_id, updated_at: j.updated_at, current: live === j.contract_hash });
      }
      return json(out);
    },
  );
}
