// The tool catalogue: every MCP tool Mynt registers, with its inputs (JSON Schema), the roles that get it, the area of
// the docs it belongs to and whether it only reads. It is read from the live registry (the same createServer path a
// signed-in user of each role gets, as llms-full.txt is), so the Studio's docs (scripts/docs-data.mjs writes it to
// docs/site/tools.json) can't drift from the server: test/tool-catalogue.test.js regenerates it and
// compares.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminContext } from "./admin.js";
import { GET_STARTED, ROLE_SUMMARY, toolsForRole } from "./llms-txt.js";
import { openApiDocument } from "./sdk.js";
import { ROLES, type Role, type Store } from "./store.js";

// The areas of the tool reference, in the order the docs show them.
export const TOOL_AREAS = [
  { id: "catalogue", title: "Catalogue & enrolment", summary: "Browse the published catalogue, read products, enrol, and ask for products that don't exist yet." },
  { id: "products", title: "Products & innovators", summary: "Compose products from regulated primitives, test, publish and version them, and decide who may build on them." },
  { id: "apps", title: "Apps & developers", summary: "Register apps, read a product's developer contract, make an app's agreements with the firms behind its products, and start from app kinds and ideas." },
  { id: "builds", title: "Builds", summary: "Coding-agent builds that Mynt verifies outside the agent's sandbox, and the repositories they push to." },
  { id: "hosting", title: "Hosting", summary: "Host verified apps on isolated machines, with their logs, domains and modules." },
  { id: "runtime", title: "Runtime keys & webhooks", summary: "App keys, client sessions, webhooks and the sandbox an app's server uses at run time." },
  { id: "sdks", title: "SDKs & journeys", summary: "Generated SDKs, experiences and customer journeys on a product's contract." },
  { id: "workspaces", title: "Workspaces", summary: "Workspaces, their members and invitations, stages and promotion, and what needs attention." },
  { id: "growth", title: "Go-to-market", summary: "Campaigns, offers and the business-development connector." },
  { id: "earn", title: "Earn & liquidity", summary: "Pools, commitments and withdrawals, and each product's health record." },
  { id: "treasury", title: "Treasury & Solana", summary: "On-chain treasuries, Solana programs and the mainnet program gate." },
  { id: "licences", title: "Licences & partners", summary: "Firms and licences, sponsorship, money rails, the partner kit and covenants." },
  { id: "vendors", title: "Vendors", summary: "Standard services per region, vendors' offerings, conformance and subscriptions." },
  { id: "compliance", title: "Compliance & audits", summary: "Workspace obligations, firm checks and the governance desk's review cases." },
  { id: "admin", title: "Admin & governance", summary: "Regions and the regulatory model, categories, take rates, invitations, oversight and operations." },
] as const;

export type ToolAreaId = (typeof TOOL_AREAS)[number]["id"];

// Each registration function (the section of the server that adds a tool) belongs to one area. A tool registered by
// a function missing here fails test/tool-catalogue.test.js.
export const AREA_OF_REGISTRAR: Record<string, ToolAreaId> = {
  registerCatalogTools: "catalogue",
  registerConsumerTools: "catalogue",
  registerProductRequestTools: "catalogue",
  registerInnovatorTools: "products",
  registerVersioningTools: "products",
  registerProductStageTools: "products",
  registerDefinitionTools: "products",
  registerMarketplaceTools: "products",
  registerProductRequestInnovatorTools: "products",
  registerTakeRateTools: "products",
  registerDeskTools: "products",
  registerExploreTools: "products",
  registerDeveloperTools: "apps",
  registerAppKindTools: "apps",
  registerAppIdeaTools: "apps",
  registerAppIdeaAdminTools: "apps",
  registerProductIdeaTools: "apps",
  registerProductIdeaAdminTools: "apps",
  registerAppRemovalTools: "apps",
  registerAppAgreementTools: "apps",
  registerAgreementEsignTools: "apps",
  registerEsignAdminTools: "admin",
  registerCodingAgentTools: "builds",
  registerCodingAgentAdminTools: "builds",
  registerRepoAccessNoticeTools: "builds",
  registerRepoApprovalAdminTools: "builds",
  registerHostingTools: "hosting",
  registerHostingAdminTools: "hosting",
  registerModuleTools: "hosting",
  registerRuntimeTools: "runtime",
  registerRuntimeInnovatorTools: "runtime",
  registerBuildTools: "sdks",
  registerJourneyTools: "sdks",
  registerWorkspaceTools: "workspaces",
  registerInvitationTools: "workspaces",
  registerLinkedAccountsTools: "workspaces",
  registerChatSessionTools: "workspaces",
  registerPromotionTools: "workspaces",
  registerPromotionAdminTools: "workspaces",
  registerAttentionTools: "workspaces",
  registerWorkspacePnlTools: "workspaces",
  createServer: "workspaces",
  registerGtmTools: "growth",
  registerConnectTools: "growth",
  registerBdAdminTools: "growth",
  registerLiquidityTools: "earn",
  registerProductHealthTools: "earn",
  registerTreasuryTools: "treasury",
  registerSolanaTools: "treasury",
  registerSolanaAdminTools: "treasury",
  registerMainnetGateTools: "treasury",
  registerLicenseProviderTools: "licences",
  registerSponsorshipBuilderTools: "licences",
  registerFirmTools: "licences",
  registerRosterTools: "licences",
  registerPartnerKitTools: "licences",
  registerCovenantTools: "licences",
  registerFirmNoticeTools: "licences",
  registerMoneyRailTools: "licences",
  registerVendorTools: "vendors",
  registerVendorInnovatorTools: "vendors",
  registerVendorAdminTools: "vendors",
  registerServiceTypeCatalog: "vendors",
  registerFirmWebhookTools: "vendors",
  registerRampAdapterTools: "vendors",
  registerWorkspaceComplianceTools: "compliance",
  registerFirmCheckAdminTools: "compliance",
  registerReviewTools: "compliance",
  registerAdminTools: "admin",
  registerTakeRateAdminTools: "admin",
  registerOpsTools: "admin",
};

export type CatalogueTool = {
  name: string;
  title: string | null;
  description: string;
  area: ToolAreaId;
  roles: Role[];
  // read: only reads (readOnlyHint); destructive: removes or overwrites (destructiveHint); write: changes data.
  access: "read" | "write" | "destructive";
  // Whether access comes from the tool's own annotation or, without one, from its name (list_*, get_*, …).
  access_from: "annotation" | "name";
  inputSchema: Record<string, unknown>;
};

export type ToolCatalogue = {
  areas: { id: ToolAreaId; title: string; summary: string; tools: number }[];
  roles: { role: Role; summary: string; tools: number; get_started: { tool: string; why: string }[] }[];
  runtime_endpoints: { method: string; path: string; auth: "app key" | "client session"; summary: string }[];
  tools: CatalogueTool[];
};

// Names that only read, for the tools that carry no annotation of their own.
const READ_NAME = /^(list|get|search|whoami|describe|preview|explain|check|show|find|read|view|compare|lint|validate|diff|summari[sz]e)_|^whoami$/;

// Every optional service, present but inert: registration only keeps a reference to it, so the catalogue lists the
// tools a fully configured server has. Nothing is ever called (no request runs).
function inertServices(): AdminContext {
  const inert = () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => null) });
  const keys = ["clerkAdmin", "identity", "workspaceSync", "builds", "bd", "desk", "review", "explore", "hosting", "modules", "solana", "gate", "productHealth", "covenants", "treasury", "esign"] as const;
  return Object.fromEntries(keys.map((k) => [k, inert()])) as AdminContext;
}

// The registration function that called registerTool: the innermost frame named register* (or createServer).
function registrarOf(stack: string | undefined): string | null {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const fn = /^\s*at (?:async )?([\w$.]+) /.exec(line)?.[1]?.split(".").pop();
    if (fn && (/^register[A-Z]\w*$/.test(fn) || fn === "createServer") && fn !== "registerTool") return fn;
  }
  return null;
}

export async function toolCatalogue(store: Store, ctx: AdminContext = inertServices()): Promise<ToolCatalogue> {
  const registrar = new Map<string, string | null>();
  const proto = McpServer.prototype as unknown as { registerTool: (...args: unknown[]) => unknown };
  const original = proto.registerTool;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  proto.registerTool = function (this: unknown, ...args: unknown[]) {
    const name = String(args[0]);
    if (!registrar.has(name)) registrar.set(name, registrarOf(new Error().stack));
    return original.apply(this, args);
  };
  const perRole: [Role, Awaited<ReturnType<typeof toolsForRole>>][] = [];
  try {
    for (const role of ROLES) perRole.push([role, await toolsForRole(store, ctx, role)]);
  } finally {
    proto.registerTool = original;
    Error.stackTraceLimit = limit;
  }

  const byName = new Map<string, CatalogueTool>();
  for (const [role, tools] of perRole) {
    for (const t of tools) {
      const seen = byName.get(t.name);
      if (seen) {
        seen.roles.push(role);
        continue;
      }
      const from = registrar.get(t.name) ?? null;
      const area = from ? AREA_OF_REGISTRAR[from] : undefined;
      if (!area) throw new Error(`tool ${t.name} is registered by ${from ?? "an unknown function"}, which has no area in AREA_OF_REGISTRAR`);
      const ann = (t as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations ?? {};
      const annotated = ann.readOnlyHint !== undefined || ann.destructiveHint !== undefined;
      const access = ann.readOnlyHint ? "read" : ann.destructiveHint ? "destructive" : !annotated && READ_NAME.test(t.name) ? "read" : "write";
      byName.set(t.name, {
        name: t.name,
        title: t.title ?? t.annotations?.title ?? null,
        description: (t.description ?? "").trim(),
        area,
        roles: [role],
        access,
        access_from: annotated ? "annotation" : "name",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      });
    }
  }
  const tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  const doc = openApiDocument("mynt", "1.0.0", "https://mynt.example", []) as {
    paths: Record<string, Record<string, { summary?: string; security?: unknown[] }>>;
  };
  const runtime_endpoints: ToolCatalogue["runtime_endpoints"] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      runtime_endpoints.push({
        method: method.toUpperCase(),
        path: `/v1${path}`,
        auth: JSON.stringify(op.security ?? "").includes("clientSession") ? "client session" : "app key",
        summary: String(op.summary ?? "").replace(/\s+/g, " ").trim(),
      });
    }
  }

  return {
    areas: TOOL_AREAS.map((a) => ({ ...a, tools: tools.filter((t) => t.area === a.id).length })),
    roles: perRole.map(([role, list]) => ({ role, summary: ROLE_SUMMARY[role], tools: list.length, get_started: GET_STARTED[role] })),
    runtime_endpoints,
    tools,
  };
}
