import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessStatus, productEntity } from "./access.js";
import { checkStructure, ExperienceSchema, renderPreview, type Experience } from "./experience.js";
import { compareSemver, generateSdk, SDK_LANGUAGES, SEMVER, termsHash, type SdkProduct } from "./sdk.js";
import { DuplicateError, type ProductRecord, type Sdk, type SdkRelease, type Store, type User } from "./store.js";

// Developer build layer: generated SDKs and structured experience definitions.

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// Generated docs and clients point at this server's public origin, or a placeholder.
const baseUrl = () => (process.env.PUBLIC_URL ?? "https://mynt.example.com").replace(/\/+$/, "");

// Access for an SDK, which isn't tied to one app: any of the developer's approvals counts.
export async function sdkAccess(store: Store, user: User, record: ProductRecord) {
  const direct = await accessStatus(store, user, record, null);
  if (direct.granted) return { granted: true, via: direct.via as string };
  const mine = (await store.requestsForProducts([record.product.id])).filter((r) => r.kind === "product_access" && r.requester_id === user.id);
  if (mine.some((r) => r.status === "approved")) return { granted: true, via: "approved" };
  if (mine.some((r) => r.status === "revoked")) return { granted: false, via: "revoked" };
  return { granted: false, via: mine.some((r) => r.status === "pending") ? "pending" : record.access_mode === "private" ? "private" : "none" };
}

// Building needs access, or an open/approval product (approval gates going live, not building).
const buildable = (record: ProductRecord, a: { granted: boolean; via: string }) =>
  record.status === "published" && (a.granted || (record.access_mode !== "private" && a.via !== "revoked"));

export async function releaseStaleness(store: Store, user: User, release: SdkRelease) {
  const reasons: string[] = [];
  for (const src of release.sources) {
    const record = await store.getProduct(src.product_id);
    if (!record || record.status !== "published") {
      reasons.push(`'${src.product_id}' was unpublished`);
      continue;
    }
    if (record.version > src.version) reasons.push(`'${src.product_id}' published version ${record.version} (release has ${src.version})`);
    if (termsHash(record.build_terms) !== src.terms_hash) reasons.push(`'${src.product_id}' changed its build terms`);
    const a = await sdkAccess(store, user, record);
    if (a.via === "revoked" || (!a.granted && record.access_mode === "private") || (src.access !== "building" && !a.granted))
      reasons.push(`Access to '${src.product_id}' was revoked`);
  }
  return { stale: reasons.length > 0, stale_reasons: reasons };
}

const byVersionDesc = (rs: SdkRelease[]) => [...rs].sort((a, b) => compareSemver(b.version, a.version));

export function registerBuildTools(server: McpServer, store: Store, user: User) {
  const ownSdk = async (id: string) => {
    const sdk = await store.getSdk(id);
    return sdk && sdk.owner_id === user.id ? sdk : undefined;
  };
  const ownApp = async (id: string) => {
    const app = await store.getApp(id);
    return app && app.owner_id === user.id ? app : undefined;
  };
  const summary = async (sdk: Sdk) => {
    const [latest] = byVersionDesc(await store.sdkReleases(sdk.id));
    return {
      ...sdk,
      latest_version: latest?.version ?? null,
      ...(latest ? await releaseStaleness(store, user, latest) : { stale: false, stale_reasons: [] }),
    };
  };

  server.registerTool(
    "create_sdk",
    {
      title: "Create an SDK",
      description:
        "Developer: define an SDK over products you can build on (open or approval products, or ones you've been let into). generate_sdk_release then produces a versioned bundle: an OpenAPI 3.1 document and typed TypeScript and/or Python clients for the Mynt app API.",
      inputSchema: {
        name: z.string().min(1).max(80),
        languages: z.array(z.enum(SDK_LANGUAGES)).min(1),
        product_ids: z.array(z.string()).min(1),
      },
    },
    async ({ name, languages, product_ids }) => {
      const ids = [...new Set(product_ids)];
      const bad: string[] = [];
      for (const id of ids) {
        const record = await store.getProduct(id);
        if (record?.status !== "published") bad.push(`${id} (not published)`);
        else if (!buildable(record, await sdkAccess(store, user, record))) bad.push(`${id} (no access)`);
      }
      if (bad.length) return fail(`Products not available: ${bad.join(", ")}`);
      return json(await store.createSdk(user.id, { name, languages: [...new Set(languages)], product_ids: ids }));
    },
  );

  server.registerTool(
    "generate_sdk_release",
    {
      title: "Generate an SDK release",
      description:
        "Developer: generate an immutable, versioned release of one of your SDKs from the products' current published versions and build terms: openapi.json plus typed clients (required disclosures and branding included as constants). Versions are semver and must increase.",
      inputSchema: {
        sdk_id: z.string(),
        version: z.string().regex(SEMVER, "semver, e.g. 1.0.0"),
        changelog: z.string().min(3),
      },
    },
    async ({ sdk_id, version, changelog }) => {
      const sdk = await ownSdk(sdk_id);
      if (!sdk) return fail(`No SDK with id '${sdk_id}'`);
      const [latest] = byVersionDesc(await store.sdkReleases(sdk.id));
      if (latest && compareSemver(version, latest.version) <= 0) return fail(`Version must be greater than ${latest.version}`);
      const products: SdkProduct[] = [];
      const sources = [];
      const bad: string[] = [];
      for (const id of sdk.product_ids) {
        const record = await store.getProduct(id);
        const a = record && (await sdkAccess(store, user, record));
        if (!record || !a || !buildable(record, a)) {
          bad.push(id);
          continue;
        }
        products.push({ record, issuer: (await productEntity(store, record))?.name ?? null });
        sources.push({ product_id: id, version: record.version, terms_hash: termsHash(record.build_terms), access: a.granted ? a.via : "building" });
      }
      if (bad.length) return fail(`No longer available to you: ${bad.join(", ")}. Create a new SDK without them.`);
      const files = await generateSdk({ name: sdk.name, version, languages: sdk.languages as never, baseUrl: baseUrl(), products });
      try {
        const release = await store.createSdkRelease({ sdk_id: sdk.id, version, changelog, sources, files });
        return json({ ...release, files: release.files.map((f) => ({ path: f.path, bytes: f.content.length })) });
      } catch (e) {
        if (e instanceof DuplicateError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_sdks",
    {
      title: "My SDKs",
      description: "Developer: your SDKs with their latest release, flagged stale when a product has changed since (new version, new terms, unpublished, or access revoked).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await Promise.all((await store.sdksByOwner(user.id)).map(summary))),
  );

  server.registerTool(
    "list_sdk_releases",
    {
      title: "Releases of an SDK",
      description: "Developer: every release of one of your SDKs, newest first, with what it was generated from and whether it's stale.",
      inputSchema: { sdk_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ sdk_id }) => {
      const sdk = await ownSdk(sdk_id);
      if (!sdk) return fail(`No SDK with id '${sdk_id}'`);
      const releases = byVersionDesc(await store.sdkReleases(sdk.id));
      return json(
        await Promise.all(
          releases.map(async ({ files, ...r }) => ({ ...r, files: files.map((f) => f.path), ...(await releaseStaleness(store, user, { ...r, files })) })),
        ),
      );
    },
  );

  server.registerTool(
    "get_sdk_release",
    {
      title: "Download an SDK release",
      description: "Developer: the files of one release of your SDK (latest if no version) as {path, content}[], with a staleness flag.",
      inputSchema: { sdk_id: z.string(), version: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ sdk_id, version }) => {
      const sdk = await ownSdk(sdk_id);
      if (!sdk) return fail(`No SDK with id '${sdk_id}'`);
      const releases = byVersionDesc(await store.sdkReleases(sdk.id));
      const release = version ? releases.find((r) => r.version === version) : releases[0];
      if (!release) return fail(version ? `No release ${version}` : "No releases yet; use generate_sdk_release");
      return json({ sdk: { id: sdk.id, name: sdk.name }, ...release, ...(await releaseStaleness(store, user, release)) });
    },
  );

  server.registerTool(
    "set_experience",
    {
      title: "Define an app's experience",
      description:
        "Developer: set the structured experience of one of your apps: screens of components (product_card, comparison_table, calculator, disclosure_block, handoff_cta, text). check_experience then checks its structure against each product's terms; publish_app refuses failures. Pass null to clear it.",
      inputSchema: { app_id: z.string(), experience: ExperienceSchema.nullable() },
    },
    async ({ app_id, experience }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      await store.setAppExperience(app.id, experience);
      if (!experience) return json({ app_id: app.id, experience: null });
      const records = (await Promise.all(app.product_ids.map((id) => store.getProduct(id)))).filter((r): r is ProductRecord => r?.status === "published");
      const structure = checkStructure(app, experience, records);
      return json({ app_id: app.id, experience, structure: { passed: structure.passed, failed_checks: structure.checks.filter((c) => c.status === "fail") } });
    },
  );

  server.registerTool(
    "render_experience_preview",
    {
      title: "Preview an experience as HTML",
      description:
        "Developer: render one of your app's experience as a self-contained HTML document (no scripts or external assets) with product data, disclosures and branding, for review.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const parsed = ExperienceSchema.safeParse(await store.appExperience(app.id));
      if (!parsed.success) return fail("This app has no experience yet; define one with set_experience");
      const products = new Map<string, { record: ProductRecord; issuer: string | null }>();
      for (const id of app.product_ids) {
        const record = await store.getProduct(id);
        if (record?.status === "published") products.set(id, { record, issuer: (await productEntity(store, record))?.name ?? null });
      }
      return { content: [{ type: "text" as const, text: renderPreview(app, parsed.data as Experience, products) }] };
    },
  );
}

// Structure of an app's stored experience, for check_experience and publish_app.
export async function experienceStructure(store: Store, app: { id: string; product_ids: string[] }, published: ProductRecord[]) {
  const stored = await store.appExperience(app.id);
  const parsed = ExperienceSchema.safeParse(stored);
  // A saved experience that no longer validates fails, rather than skipping the structural checks.
  if (stored != null && !parsed.success) {
    return {
      defined: true,
      passed: false,
      checks: [{ product_id: "*", name: "experience_valid", status: "fail" as const, message: "The saved experience no longer validates; set it again with set_experience" }],
      rendered_disclosures: [],
    };
  }
  return checkStructure(app, parsed.success ? parsed.data : null, published);
}
