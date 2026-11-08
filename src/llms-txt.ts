// /llms.txt and /llms-full.txt (https://llmstxt.org): what Mynt is and how to use it, for AI assistants.
// llms.txt is a short hand-written guide; llms-full.txt is generated from the live tool registry (the
// same createServer path a signed-in user of each role gets), so it never goes stale.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AdminContext } from "./admin.js";
import { DEFINITION_SCHEMA_URI } from "./definition-tools.js";
import { openApiDocument, SDK_LANGUAGES } from "./sdk.js";
import { createServer } from "./server.js";
import { ROLES, type Role, type Store, type User } from "./store.js";

const FALLBACK_REPO = "https://github.com/never2average/mynt";

// The public repository, from package.json when it says so.
export const REPO_URL: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const raw = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? pkg.homepage);
    if (typeof raw === "string" && raw) return raw.replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  } catch {
    // fall through
  }
  return FALLBACK_REPO;
})();

export const ROLE_SUMMARY: Record<Role, string> = {
  consumer: "uses financial products: enrols, sees offers, asks for products that don't exist yet.",
  developer: "the builder role, under its other name: builds apps (keys, webhooks, SDKs, journeys, GTM campaigns) with coding agents Mynt verifies and hosts, and composes and publishes products too. The same tools as innovator. Also a consumer.",
  innovator: "the builder role: composes, tests, publishes and versions financial products from regulated primitives, decides who may build on them, and builds apps on them. Needn't be licensed: a licence provider can sponsor a product under its licences. The same tools as developer. Also a consumer.",
  vendor: "a firm offering standard services per region (identity, KYC, account data, bureau, e-sign, e-mandate, the ramp) that builders plug into products. A peer of builders.",
  license_provider: "a firm, added by an admin, holding licences (verified by admins) that sponsor builders' products: it approves, declines or revokes sponsorship of a product's component under a held licence, in the jurisdictions it covers. A peer of builders.",
  admin: "runs Mynt itself: regions, the regulatory model, product categories, service types, take rates, invites and oversight. Holds every other role.",
};

// The first tools each role should call. test/llms-txt.test.js checks every name against the role's real tools.
export const GET_STARTED: Record<Role, { tool: string; why: string }[]> = {
  consumer: [
    { tool: "whoami", why: "see your granted and effective roles" },
    { tool: "list_products", why: "browse the published catalogue" },
    { tool: "get_product", why: "read one product in full" },
    { tool: "enroll_in_product", why: "enrol in a product" },
    { tool: "request_product", why: "ask for a product that doesn't exist yet" },
  ],
  developer: [
    { tool: "list_buildable_products", why: "products you may build on" },
    { tool: "request_product_access", why: "ask an innovator for access" },
    { tool: "create_app", why: "register your app" },
    { tool: "get_developer_contract", why: "the product's API contract for your app" },
    { tool: "create_api_key", why: "an app key for your server (never ship it to devices)" },
  ],
  innovator: [
    { tool: "create_entity", why: "register your firm" },
    { tool: "register_license", why: "add the licences an admin will verify" },
    { tool: "create_product", why: "start a product" },
    { tool: "set_product_definition", why: "compose it from regulated primitives (validate with check_product_definition)" },
    { tool: "publish_product", why: "publish once its tests pass (test_product)" },
  ],
  license_provider: [
    { tool: "get_my_entity", why: "your firm, as an admin registered it; share its id with builders" },
    { tool: "register_license", why: "add the licences an admin will verify" },
    { tool: "list_sponsorship_requests", why: "builders asking you to sponsor their products" },
    { tool: "approve_sponsorship", why: "sponsor a product under your licences, where they cover" },
    { tool: "list_sponsored_products", why: "what you sponsor (revoke_sponsorship to stop)" },
  ],
  vendor: [
    { tool: "get_my_entity", why: "your firm, as an admin registered it" },
    { tool: "list_service_types", why: "the standard services defined per region" },
    { tool: "create_vendor_offering", why: "offer one from your test endpoint" },
    { tool: "run_conformance", why: "let Mynt test your endpoint against the contract" },
    { tool: "list_my_subscribers", why: "innovators subscribed to your offerings" },
  ],
  admin: [
    { tool: "define_region", why: "add a region and its regulators" },
    { tool: "define_product_category", why: "add product categories per product line" },
    { tool: "invite_user", why: "invite people with their roles" },
    { tool: "register_firm", why: "add a firm by hand" },
    { tool: "audit_log", why: "see what changed and who changed it" },
  ],
};

export function llmsTxt(base: string): string {
  const repo = REPO_URL;
  const started = ROLES.map(
    (r) => `### ${r[0].toUpperCase()}${r.slice(1)}\n\n${GET_STARTED[r].map((s, i) => `${i + 1}. \`${s.tool}\`: ${s.why}`).join("\n")}`,
  ).join("\n\n");
  return `# Mynt

> Mynt is Lovable for finance apps: a platform where builders compose financial products from regulated primitives and build apps on them with coding agents that Mynt verifies and hosts, licence providers sponsor those products under their licences, vendors offer standard services per region, and admins keep the regulatory model. Everything is reached through one MCP server.

Mynt's MCP endpoint is \`${base}/mcp\` (Streamable HTTP, JSON-RPC over POST). Sign in with OAuth: the authorization server is advertised at \`${base}/.well-known/oauth-protected-resource/mcp\` (RFC 9728), and any MCP client that supports OAuth discovers it from the \`WWW-Authenticate\` header of a 401. Access is by invitation: an admin invites you with your roles, and you sign in with the email they invited.

Tools are registered per user, so you only see the tools your roles allow. Roles nest (admin > builder > consumer); innovator and developer are two names for the builder role, and vendors and licence providers stand beside builders:

${ROLES.map((r) => `- **${r}**: ${ROLE_SUMMARY[r]}`).join("\n")}

Apps don't use the MCP endpoint at run time. They call the runtime API at \`${base}/v1\`: the app's server holds its app key (\`Authorization: Bearer <app key>\`) and mints short-lived client sessions (\`POST /v1/client_sessions\`) for customers' devices, which call \`/v1/client/*\` with those. App keys never go to devices or browsers.

## Get started

${started}

## Docs

- [Every tool, per role, with inputs](${base}/llms-full.txt): generated from the live tool registry, plus the runtime API and the vendor contract
- [README](${repo}#readme): what Mynt is and why
- [Technical reference](${repo}/blob/main/docs/reference.md): tools, the runtime API, hosting, deployment and operations
- [Roles and their tools](${repo}/blob/main/docs/reference.md#mynt-technical-reference)
- [Vendors: standard services per region](${repo}/blob/main/docs/reference.md#vendors-standard-services-per-region)
- [Product lines, actions and primitives](${repo}/blob/main/docs/reference.md#product-lines-actions-and-primitives)
- [Architecture](${repo}/blob/main/docs/architecture.md)

## Machine-readable

- [OAuth protected resource metadata](${base}/.well-known/oauth-protected-resource/mcp)
- MCP resource \`${DEFINITION_SCHEMA_URI}\`: the JSON Schema of product definitions ([source](${repo}/blob/main/schemas/financial-product.v2.schema.json))
- MCP resource \`mynt://catalog\`: the published catalogue

## Optional

- [Source code](${repo}): TypeScript, MIT licence
- [Rules for coding agents working on Mynt](${repo}/blob/main/AGENTS.md)
- [Request early access](${repo}/issues/new?title=Early%20access%20request)
`;
}

type Tool = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { title?: string } };

// The tools a signed-in user holding exactly `role` gets, through the same code path as a real request.
export async function toolsForRole(store: Store, ctx: AdminContext, role: Role): Promise<Tool[]> {
  const user: User = { id: `llms-txt-${role}`, name: `llms.txt ${role}`, roles: [role], email: null, entity_id: null, created_at: new Date(0).toISOString() };
  const { bdRun: _bdRun, ...personCtx } = ctx;
  const server = createServer(store, user, personCtx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "llms-txt", version: "1.0.0" });
  try {
    await client.connect(clientT);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...(page.tools as Tool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
    await server.close();
  }
}

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

function typeOf(s: Record<string, any> | undefined): string {
  if (!s || typeof s !== "object") return "any";
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  for (const k of ["anyOf", "oneOf"]) if (Array.isArray(s[k])) return [...new Set(s[k].map((x: any) => typeOf(x)))].join(" | ");
  if (s.type === "array") return `${typeOf(s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return s.type ?? "any";
}

function renderSchema(schema: Record<string, any> | undefined): string {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, any>>;
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const names = Object.keys(props);
  if (!names.length) return "Input: none";
  return ["Input:", ...names.map((n) => {
    const p = props[n];
    const d = oneLine(p.description);
    return `- \`${n}\` (${typeOf(p)}${required.has(n) ? ", required" : ""})${d ? `: ${d}` : ""}`;
  })].join("\n");
}

function renderTool(t: Tool): string {
  const title = t.title ?? t.annotations?.title;
  return `### ${t.name}${title ? ` (${oneLine(title)})` : ""}\n\n${(t.description ?? "").trim() || "No description."}\n\n${renderSchema(t.inputSchema)}`;
}

function runtimeEndpoints(base: string): string {
  const doc = openApiDocument("mynt", "1.0.0", base, []) as { paths: Record<string, Record<string, { summary?: string; security?: unknown[] }>> };
  const lines: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const auth = JSON.stringify(op.security ?? "").includes("clientSession") ? "client session" : "app key";
      lines.push(`- \`${method.toUpperCase()} /v1${path}\` (${auth}): ${oneLine(op.summary)}`);
    }
  }
  return lines.join("\n");
}

const VENDOR_CONTRACT = `Mynt calls a vendor's offering with \`POST <base_url>/v1/<service_type_key>\`, JSON body \`{ request_id, environment: "test" | "live", input, params?, quote?, consent: { purpose, artefact_ref, given_at } }\`, a \`Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">\` header (signing secret per subscription) and, when the offering needs one, \`Authorization: Bearer <the subscriber's credential>\`. The vendor answers \`200\` with \`{ request_id, status: "ok" | "error", output, error }\`, the output valid against the service type's output_schema; answers \`401\` to a bad signature or a timestamp over 300 seconds old; and treats a repeated \`request_id\` as a replay. Asynchronous services may answer \`status: "pending"\` with a \`redirect_url\`, then send the final answer to \`POST /v1/vendor/callback/<subscription_id>\`, signed the same way. Before listing, Mynt tests an offering itself (\`run_conformance\`). Billing is between vendor and innovator, never through Mynt.`;

export async function llmsFullTxt(store: Store, ctx: AdminContext, base: string): Promise<string> {
  const perRole = await Promise.all(ROLES.map(async (r) => [r, await toolsForRole(store, ctx, r)] as const));
  // Each role's list names every tool it gets; each tool is described once, below, with the roles that get it.
  const byName = new Map<string, { tool: Tool; roles: Role[] }>();
  for (const [r, tools] of perRole) for (const t of tools) (byName.get(t.name) ?? byName.set(t.name, { tool: t, roles: [] }).get(t.name)!).roles.push(r);
  const roleLists = perRole.map(
    ([r, tools]) =>
      `### ${r}\n\nA ${r} ${ROLE_SUMMARY[r]} ${tools.length} tools:\n\n${tools.map((t) => `- \`${t.name}\`${t.title ? `: ${oneLine(t.title)}` : ""}`).join("\n")}`,
  );
  const reference = [...byName.values()]
    .sort((a, b) => a.tool.name.localeCompare(b.tool.name))
    .map(({ tool, roles }) => `${renderTool(tool)}\n\nRoles: ${roles.join(", ")}`);
  const sections = [`## Tools by role\n\n${roleLists.join("\n\n")}`, `## Tool reference\n\n${reference.join("\n\n")}`];
  return `# Mynt: full reference for AI assistants

> Every MCP tool each role gets, generated from the live tool registry of this server, plus the runtime API for apps and the vendor wire contract. The short guide is ${base}/llms.txt.

MCP endpoint: \`${base}/mcp\` (Streamable HTTP; OAuth sign-in via \`${base}/.well-known/oauth-protected-resource/mcp\`). A role's tool list includes the tools of the roles it nests over (admin > innovator > developer > consumer; vendors beside innovators). "Tools by role" lists every tool each role gets; "Tool reference" describes each tool once, with its inputs and the roles that get it.

${sections.join("\n\n")}

## Runtime API for apps

Base \`${base}/v1\`. The app's server authenticates with its app key (\`Authorization: Bearer <app key>\`); customers' devices use a client session the server mints with \`POST /v1/client_sessions\`. Each app's own OpenAPI document and typed SDKs come from the developer tools (\`get_product_sdk\`, \`generate_sdk_release\`).

${runtimeEndpoints(base)}

## Vendor wire contract

${VENDOR_CONTRACT}

## SDKs and schemas

- Generated SDKs for each app: ${SDK_LANGUAGES.join(", ")} (developer tools \`create_sdk\`, \`generate_sdk_release\`, \`get_sdk_release\`); templates in ${REPO_URL}/tree/main/sdk-templates
- Product definition JSON Schema: MCP resource \`${DEFINITION_SCHEMA_URI}\`, source ${REPO_URL}/blob/main/schemas/financial-product.v2.schema.json
- Service type examples (JSON): ${REPO_URL}/tree/main/schemas/service-types
`;
}

// llms-full.txt changes only on deploy; keep one copy (per public base) for five minutes.
export function llmsFullCache(store: Store, ctx: AdminContext, ttlMs = 300_000) {
  let cached: { base: string; at: number; body: Promise<string> } | null = null;
  return (base: string): Promise<string> => {
    if (!cached || cached.base !== base || Date.now() - cached.at > ttlMs) {
      const body = llmsFullTxt(store, ctx, base);
      const entry = { base, at: Date.now(), body };
      cached = entry;
      body.catch(() => {
        if (cached === entry) cached = null;
      });
    }
    return cached.body;
  };
}
