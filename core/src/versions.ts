import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FinancialProduct } from "./catalog.js";
import { DuplicateError, type Store, type User } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export function diffProducts(from: FinancialProduct, to: FinancialProduct) {
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])] as (keyof FinancialProduct)[];
  return keys
    .filter((k) => k !== "id" && JSON.stringify(from[k]) !== JSON.stringify(to[k]))
    .map((k) => ({ field: k, from: from[k], to: to[k] }));
}

// Innovator: versions of their own published products. A new version is drafted from the live one,
// then tested and published like a new product (test_product / publish_product act on the draft).
export function registerVersioningTools(server: McpServer, store: Store, user: User, productFields: Record<string, z.ZodTypeAny>) {
  const ownProduct = async (id: string) => {
    const record = await store.getProduct(id);
    return record && record.owner_id === user.id ? record : undefined;
  };

  server.registerTool(
    "create_product_version",
    {
      title: "Draft a new version of a product",
      description:
        "Innovator: start the next version of one of your published products from its live version, with a changelog. Fields you pass change; then test_product and publish_product. The live version keeps serving until then.",
      inputSchema: {
        id: z.string(),
        changelog: z.string().min(3).describe("What changes for customers in this version"),
        ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])),
      },
    },
    async ({ id, changelog, ...changes }) => {
      const record = await ownProduct(id as string);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status !== "published") return fail("Only a published product gets new versions; edit the draft with update_product instead");
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      try {
        const draft = await store.createDraftVersion(id as string, { ...record.product, ...defined } as FinancialProduct, changelog as string);
        return json({ ...draft, live_version: record.version, changes: diffProducts(record.product, draft.data) });
      } catch (e) {
        if (e instanceof DuplicateError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "update_product_version",
    {
      title: "Edit a draft version",
      description: "Innovator: change the draft version of one of your products. Only fields you pass change; it must be tested again before publishing.",
      inputSchema: {
        id: z.string(),
        changelog: z.string().min(3).optional(),
        ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])),
      },
    },
    async ({ id, changelog, ...changes }) => {
      if (!(await ownProduct(id as string))) return fail(`No product of yours with id '${id}'`);
      const draft = await store.draftVersion(id as string);
      if (!draft) return fail(`'${id}' has no draft version; start one with create_product_version`);
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return json(await store.saveDraftVersion(id as string, { ...draft.data, ...defined } as FinancialProduct, (changelog as string) ?? draft.changelog));
    },
  );

  server.registerTool(
    "list_product_versions",
    {
      title: "Version history",
      description: "Innovator: every version of one of your products (published, superseded and any draft) with changelogs and test results.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      const versions = await store.productVersions(id);
      return json({
        live_version: record.status === "published" ? record.version : null,
        versions: versions.map((v) => ({ version: v.version, status: v.status, changelog: v.changelog, test_passed: v.last_test?.passed ?? null, published_at: v.published_at })),
      });
    },
  );

  server.registerTool(
    "diff_product_versions",
    {
      title: "Compare two versions",
      description: "Innovator: the fields that differ between two versions of one of your products.",
      inputSchema: { id: z.string(), from_version: z.number().int().min(1), to_version: z.number().int().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ id, from_version, to_version }) => {
      if (!(await ownProduct(id))) return fail(`No product of yours with id '${id}'`);
      const versions = await store.productVersions(id);
      const from = versions.find((v) => v.version === from_version);
      const to = versions.find((v) => v.version === to_version);
      if (!from || !to) return fail(`Unknown version; '${id}' has ${versions.map((v) => v.version).join(", ") || "no recorded versions"}`);
      return json({ id, from_version, to_version, changes: diffProducts(from.data, to.data) });
    },
  );

  server.registerTool(
    "restore_product_version",
    {
      title: "Roll back to an earlier version",
      description: "Innovator: draft a new version whose terms are copied from an earlier one (history stays linear). Test and publish it to roll back.",
      inputSchema: { id: z.string(), version: z.number().int().min(1) },
    },
    async ({ id, version }) => {
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status !== "published") return fail("Only a published product can be rolled back");
      const old = (await store.productVersions(id)).find((v) => v.version === version);
      if (!old) return fail(`'${id}' has no version ${version}`);
      try {
        return json(await store.createDraftVersion(id, old.data, `Restore version ${version}`));
      } catch (e) {
        if (e instanceof DuplicateError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "upgrade_enrollments",
    {
      title: "Upgrade enrollments to the live version",
      description: "Innovator: move every active enrollment in one of your products from an older version onto the live version.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status !== "published") return fail("The product is not published");
      return json({ id, live_version: record.version, upgraded: await store.upgradeEnrollments(id) });
    },
  );
}
