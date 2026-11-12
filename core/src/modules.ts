import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessStatus } from "./access.js";
import type { ContractAction } from "./contract.js";
import type { Db } from "./db.js";
import type { Store, User } from "./store.js";

// Developer modules: reusable pieces developers vibecode on top of products' developer contracts (an EMI
// planner, a loan-with-cover journey step, a webhook handler) and publish under their own namespace for
// other apps to use. A module's manifest says what it's built on and Mynt checks every claim against the
// live contracts: the actions exist and may run where the module runs (client modules only client actions,
// isomorphic ones only actions that run either side), it declares every consent those actions need, and a
// client module that shows offers renders every document its products require. A module is "verified" when
// its code comes from a build Mynt verified; once a product publishes a new contract, modules built on the
// old one are listed as outdated until their author republishes.

const Version = z.string().regex(/^\d+\.\d+\.\d+$/, "Use semver, e.g. 1.0.0");
export const ModuleManifestSchema = z
  .object({
    module: z.string().regex(/^@[a-z0-9][a-z0-9-]{1,38}\/[a-z0-9][a-z0-9-]{1,63}$/, "Name it @namespace/name"),
    version: Version,
    description: z.string().min(10).max(500),
    runtime: z.enum(["client", "server", "isomorphic"]),
    built_on: z
      .array(z.object({ product_id: z.string(), contract_version: z.number().int().min(1), actions: z.array(z.string()).min(1) }).strict())
      .min(1)
      .max(10),
    exports: z
      .array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), kind: z.enum(["function", "component", "journey_step", "webhook_handler"]), renders_documents: z.array(z.string()).default([]) }).strict())
      .min(1)
      .max(50),
    consent_purposes: z.array(z.string()).default([]),
    visibility: z.enum(["public", "private"]).default("public"),
    source_build_id: z.string().optional().describe("The build Mynt verified that produced this module's code"),
    license: z.string().max(40).optional(),
  })
  .strict();
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.module_namespaces (
    namespace text PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.sdk_modules (
    module text NOT NULL,
    version text NOT NULL,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    runtime text NOT NULL,
    visibility text NOT NULL,
    verified boolean NOT NULL,
    manifest jsonb NOT NULL,
    contract_hashes jsonb NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (module, version)
  );
`;

const surfaceOk = (runtime: ModuleManifest["runtime"], a: ContractAction) =>
  runtime === "server" ? true : runtime === "client" ? a.surface === "client" || a.surface === "either" : a.surface === "either";

export async function checkModule(store: Store, user: User, m: ModuleManifest) {
  const errors: string[] = [];
  const hashes: Record<string, string> = {};
  const neededPurposes = new Set<string>();
  const requiredDocs = new Set<string>();
  for (const b of m.built_on) {
    const record = await store.getProduct(b.product_id);
    const contract = record?.status === "published" ? record.pins?.contract : undefined;
    if (!record || !contract) {
      errors.push(`'${b.product_id}' isn't a published product with a developer contract`);
      continue;
    }
    if (record.access_mode === "private" && !(await accessStatus(store, user, record, null)).granted) errors.push(`'${b.product_id}' is private and you have no access`);
    if (b.contract_version !== contract.version) errors.push(`'${b.product_id}' is on contract version ${contract.version}, not ${b.contract_version}: rebuild against it`);
    hashes[b.product_id] = contract.contract_hash;
    for (const id of b.actions) {
      const a = contract.actions.find((x) => x.id === id);
      if (!a) errors.push(`'${b.product_id}' has no action '${id}'`);
      else if (!surfaceOk(m.runtime, a)) errors.push(`a ${m.runtime} module can't use '${id}', which runs on the ${a.surface === "either" ? "client or server" : a.surface} side`);
      else if (a.consent_purpose) neededPurposes.add(a.consent_purpose);
    }
    for (const d of Object.keys(contract.documents)) requiredDocs.add(d);
  }
  for (const p of neededPurposes) if (!m.consent_purposes.includes(p)) errors.push(`declare consent purpose '${p}': an action the module uses needs it`);
  const rendered = new Set(m.exports.flatMap((e) => e.renders_documents));
  if (m.runtime !== "server" && m.exports.some((e) => e.kind === "component" || e.kind === "journey_step"))
    for (const d of requiredDocs) if (!rendered.has(d)) errors.push(`a component showing these products must render document '${d}'`);
  let verified = false;
  if (m.source_build_id) {
    const build = await store.buildRun(m.source_build_id);
    if (!build || build.developer_id !== user.id) errors.push(`No build of yours with id '${m.source_build_id}'`);
    else if (build.status !== "succeeded") errors.push(`Build '${m.source_build_id}' didn't pass Mynt's verification`);
    else verified = true;
  }
  return { errors, hashes, verified };
}

export class ModuleRegistry {
  private constructor(private readonly db: Db) {}
  static async open(db: Db) {
    await db.exec(TABLES);
    return new ModuleRegistry(db);
  }

  // Namespaces are first come, first served; the first module published claims one.
  async claim(namespace: string, ownerId: string): Promise<boolean> {
    await this.db.query("INSERT INTO financial_products.module_namespaces (namespace, owner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [namespace, ownerId]);
    const r = (await this.db.query("SELECT owner_id FROM financial_products.module_namespaces WHERE namespace = $1", [namespace])).rows[0] as { owner_id: string };
    return r.owner_id === ownerId;
  }

  async publish(ownerId: string, m: ModuleManifest, verified: boolean, hashes: Record<string, string>): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO financial_products.sdk_modules (module, version, owner_id, runtime, visibility, verified, manifest, contract_hashes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING module`,
      [m.module, m.version, ownerId, m.runtime, m.visibility, verified, JSON.stringify(m), JSON.stringify(hashes)],
    );
    return r.rows.length > 0;
  }

  async list(viewerId: string, query?: string) {
    const rows = (
      await this.db.query(
        `SELECT module, version, owner_id, runtime, visibility, verified, manifest, contract_hashes, published_at FROM financial_products.sdk_modules
         WHERE (visibility = 'public' OR owner_id = $1) AND ($2::text IS NULL OR module ILIKE '%' || $2 || '%' OR manifest->>'description' ILIKE '%' || $2 || '%')
         ORDER BY module, published_at DESC`,
        [viewerId, query ?? null],
      )
    ).rows as { module: string; version: string; owner_id: string; runtime: string; visibility: string; verified: boolean; manifest: ModuleManifest; contract_hashes: Record<string, string>; published_at: string }[];
    return rows;
  }
}

export function registerModuleTools(server: McpServer, store: Store, user: User, registry: ModuleRegistry) {
  server.registerTool(
    "check_module",
    {
      title: "Check a module manifest",
      description:
        "Developer: check a module's manifest against the live developer contracts it's built on: the actions exist and may run where the module runs (client: client actions; server: any; isomorphic: only actions that run either side), it declares every consent those actions need, and a client component renders every document its products require.",
      inputSchema: { manifest: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    async ({ manifest }) => {
      const parsed = ModuleManifestSchema.safeParse(manifest);
      if (!parsed.success) return json({ valid: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`) });
      const { errors, verified } = await checkModule(store, user, parsed.data);
      return json({ valid: errors.length === 0, errors, verified });
    },
  );

  server.registerTool(
    "publish_module",
    {
      title: "Publish a module",
      description:
        "Developer: publish a module under your namespace (the first module you publish under @namespace claims it). Versions are immutable. It's marked verified when source_build_id is a build Mynt verified. Other developers find it with list_modules; once a product it's built on publishes a new contract, it's listed as outdated until you publish a version built on that contract.",
      inputSchema: { manifest: z.record(z.string(), z.unknown()) },
    },
    async ({ manifest }) => {
      const parsed = ModuleManifestSchema.safeParse(manifest);
      if (!parsed.success) return fail("The manifest doesn't match the spec", parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`));
      const m = parsed.data;
      const { errors, hashes, verified } = await checkModule(store, user, m);
      if (errors.length) return fail("The module doesn't pass its checks", errors);
      const namespace = m.module.split("/")[0];
      if (!(await registry.claim(namespace, user.id))) return fail(`${namespace} belongs to another developer`);
      if (!(await registry.publish(user.id, m, verified, hashes))) return fail(`${m.module}@${m.version} is already published; bump the version`);
      await store.audit(user.id, "publish_module", `${m.module}@${m.version}`, { verified, built_on: m.built_on.map((b) => b.product_id) });
      return json({ module: m.module, version: m.version, verified, visibility: m.visibility });
    },
  );

  server.registerTool(
    "list_modules",
    {
      title: "Developer modules",
      description: "Developer: public modules (and your private ones), each with whether it's verified and whether it's still built on its products' live contracts.",
      inputSchema: { query: z.string().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const out = [];
      for (const r of await registry.list(user.id, query)) {
        let current = true;
        for (const [productId, hash] of Object.entries(r.contract_hashes)) if ((await store.getProduct(productId))?.pins?.contract?.contract_hash !== hash) current = false;
        out.push({ module: r.module, version: r.version, runtime: r.runtime, visibility: r.visibility, verified: r.verified, current, description: r.manifest.description, built_on: r.manifest.built_on, exports: r.manifest.exports, mine: r.owner_id === user.id });
      }
      return json(out);
    },
  );
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, errors?: string[]) => ({ ...json({ error, ...(errors ? { errors } : {}) }), isError: true });
