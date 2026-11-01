#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AgentMeter } from "./agent-meter.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClerkAdmin, ClerkAuth, clerkConfigFromEnv } from "./auth.js";
import { sandboxesFromEnv } from "./freestyle-sandboxes.js";
import { BdService, bdConfigFromEnv } from "./bd.js";
import { HostingService, hostingConfigFromEnv, hostingProviderFromEnv } from "./hosting.js";
import { egressFor } from "./hosting-tools.js";
import { ModuleRegistry } from "./modules.js";
import { driftSweep } from "./pins.js";
import { DeskService, deskConfigFromEnv } from "./desk.js";
import { ReviewService, reviewConfigFromEnv } from "./review.js";
import { BuildService, buildConfigFromEnv } from "./builds.js";
import { connectPostgres } from "./db.js";
import { createMcpHttpServer } from "./http.js";
import { GitHubApp } from "./github.js";
import { startWebhookWorker } from "./runtime.js";
import { createServer } from "./server.js";
import { ROLES, Store, type Role } from "./store.js";

const USAGE = `Usage:
  mynt [serve]                         Run over stdio (token from FINANCIAL_PRODUCTS_TOKEN)
  mynt serve-http [--port 3000] [--host 127.0.0.1]
  mynt users invite --email <email> --role <${ROLES.join("|")}> [--role ...]   (bootstrap; admins then use Mynt)
  mynt users revoke --email <email>
  mynt users add --name <name> --role <role> [--role ...]   Local token (stdio, or HTTP without Clerk)
  mynt users list
  mynt clerk setup                     Turn on Clerk's allowlist and MCP client registration
  mynt hosting wg-peers                The gateway's WireGuard peers (running tenants)
  mynt hosting egress-allowlist        Hosts tenant VMs may reach through the gateway
  mynt hosting routes                  Caddy sites for hosted apps (<app>.<HOSTING_APPS_DOMAIN> to the tenant tunnel)

Environment:
  DATABASE_URL              Postgres connection string, e.g. your Supabase database (required)
  CLERK_SECRET_KEY          With CLERK_PUBLISHABLE_KEY and PUBLIC_URL: HTTP requires Clerk sign-in + whitelist
  CLERK_PUBLISHABLE_KEY
  PUBLIC_URL                Public origin of this server, e.g. https://mcp.example.com
  FINANCIAL_PRODUCTS_FILE   JSON catalog used to seed published products
  FINANCIAL_PRODUCTS_TOKEN  User token for stdio mode; omit to browse as a guest
  BOAT_API_KEY              With PUBLIC_URL and a model backend: coding-agent builds in boat.dev sandboxes (BUILD_CAP_USD, ...)
  SANDBOX_PROVIDER=freestyle  Agent sandboxes on Freestyle VMs instead (with FREESTYLE_API_KEY; FREESTYLE_USD_PER_HOUR for spend caps)
  FREESTYLE_API_KEY         Developers' hosting on Freestyle VMs (direct: per-domain egress, public routes, SSH logins)
  GOOGLE_APPLICATION_CREDENTIALS  Service account key file: build agents use Claude on Vertex AI (VERTEX_PROJECT_ID, VERTEX_REGION=global)
  DESK_JOB_CAP_USD          Innovators' product desk (with BOAT_API_KEY and the GitHub App): per-job and DESK_MONTHLY_CAP_USD per-firm caps
  REVIEW_AUTO_OPEN=1        Open a governance review for every licence awaiting review (REVIEW_CASE_CAP_USD, REVIEW_MONTHLY_CAP_USD)
  BD_ENABLED=1              Runs Mynt's connector agent (business development) on the same harness (BD_DAILY_CAP, BD_RUN_CAP_USD, ...)
  ANTHROPIC_API_KEY         Otherwise, build agents use the Anthropic API. Either way the credentials stay on Mynt's server
  GITHUB_APP_ID             With GITHUB_APP_PRIVATE_KEY and GITHUB_APP_SLUG: builds push branches and open PRs
  HOSTING_DO_TOKEN          With HOSTING_GATEWAY_ENDPOINT, HOSTING_GATEWAY_PUBLIC_KEY and PUBLIC_URL: a VM per developer for hosted apps
                            (HOSTING_REGION, HOSTING_SIZE, HOSTING_DO_IMAGE, HOSTING_GATEWAY_IP, HOSTING_APPS_DOMAIN)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string", multiple: true },
    port: { type: "string", default: process.env.PORT ?? "3000" },
    host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
    help: { type: "boolean", short: "h" },
  },
});

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const openDb = () => connectPostgres(process.env.DATABASE_URL ?? die("DATABASE_URL is required (your Supabase Postgres connection string)"));
const openStore = () => Store.open(openDb());

const openServices = async () => {
  const db = openDb();
  const store = await Store.open(db);
  const boat = sandboxesFromEnv();
  const buildConfig = buildConfigFromEnv();
  const github = GitHubApp.fromEnv();
  const builds = await BuildService.open(db, store, boat, github, buildConfig);
  // Innovators' product desk: their models run as code in sandboxes; agents only for the thinking.
  const desk = await DeskService.open(db, store, boat, github, deskConfigFromEnv(buildConfig));
  // The connector agent shares the builds' sandbox host and model backend. Channels plug in later.
  const bd = await BdService.open(db, boat, bdConfigFromEnv(buildConfig));
  // The governance desk: review agents steered by workspaces/governance-review; admins decide.
  const review = await ReviewService.open(db, store, boat, reviewConfigFromEnv(buildConfig), desk);
  // Developers' hosting: a VM each, fetching their verified commits with a read-only GitHub token.
  const hosting = await HostingService.open(db, hostingProviderFromEnv(), hostingConfigFromEnv(), async (developerId, repository) => {
    if (!github) return null;
    const r = await db.query("SELECT installation_id FROM financial_products.repo_connections WHERE developer_id = $1 AND repository = $2", [developerId, repository.toLowerCase()]);
    const installation = (r.rows[0] as { installation_id?: number } | undefined)?.installation_id;
    return installation ? github.readTokenFor(repository, Number(installation)).catch(() => null) : null;
  });
  const modules = await ModuleRegistry.open(db);
  // Every agent's model calls are metered at the proxy, against its run's cap.
  const meter = await AgentMeter.open(db);
  for (const s of [builds, bd, desk, review]) s.meter = meter;
  return { store, builds, bd, desk, review, hosting, modules };
};

const parseRoles = (): Role[] => {
  const roles = values.role ?? [];
  if (roles.length === 0) die(USAGE);
  const invalid = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (invalid.length) die(`Unknown role(s): ${invalid.join(", ")}. Use ${ROLES.join(", ")}`);
  return [...new Set(roles)] as Role[];
};

const parseEmail = (): string => {
  const email = values.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die("--email <address> is required");
  return email!;
};

const clerkAdmin = () => (process.env.CLERK_SECRET_KEY ? new ClerkAdmin(process.env.CLERK_SECRET_KEY) : null);

const [command = "serve", sub] = positionals;
if (values.help) {
  console.log(USAGE);
} else if (command === "serve") {
  const { store, builds, bd, desk, review, hosting, modules } = await openServices();
  const token = process.env.FINANCIAL_PRODUCTS_TOKEN;
  const user = token ? ((await store.userByToken(token)) ?? die("FINANCIAL_PRODUCTS_TOKEN is not a valid token")) : null;
  await createServer(store, user, { clerkAdmin: clerkAdmin(), builds, bd, desk, review, hosting, modules }).connect(new StdioServerTransport());
} else if (command === "serve-http") {
  const port = Number(values.port);
  const { store, builds, bd, desk, review, hosting, modules } = await openServices();
  builds.startWorker();
  bd.startWorker();
  desk.startWorker();
  review.startWorker();
  const config = clerkConfigFromEnv();
  const clerk = config ? new ClerkAuth(config, store) : null;
  const http = createMcpHttpServer(store, clerk, { clerkAdmin: clerkAdmin(), builds, bd, desk, review, hosting, modules }).listen(port, values.host, () =>
    console.error(`mynt MCP listening on http://${values.host}:${port}/mcp${clerk ? " (Clerk whitelist auth)" : ""}`),
  );
  // Sends queued webhook deliveries (events from any process sharing the database).
  const webhooks = startWebhookWorker(store);
  // Licences lapse with time: re-check pinned products hourly (changes made through Mynt re-check at once).
  const drift = setInterval(() => driftSweep(store).catch((e) => console.error("drift sweep:", e)), 60 * 60 * 1000);
  drift.unref();
  process.on("SIGTERM", () => {
    clearInterval(drift);
    webhooks.stop();
    builds.stopWorker();
    bd.stopWorker();
    desk.stopWorker();
    review.stopWorker();
    http.close(() => process.exit(0));
  });
} else if (command === "users" && sub === "invite") {
  const email = parseEmail();
  const roles = parseRoles();
  const store = await openStore();
  const invite = await store.upsertInvite(email, roles);
  const warning = await clerkAdmin()?.allow(email);
  if (warning) console.error(`warning: ${email} ${warning}`);
  console.log(JSON.stringify(invite, null, 2));
  await store.close();
} else if (command === "users" && sub === "revoke") {
  const email = parseEmail();
  const store = await openStore();
  const removed = await store.deleteInvite(email);
  await clerkAdmin()?.disallow(email);
  console.log(removed ? `Revoked ${email}` : `${email} was not on the whitelist`);
  await store.close();
} else if (command === "users" && sub === "add") {
  if (!values.name) die(USAGE);
  const roles = parseRoles();
  const store = await openStore();
  const { user, token } = await store.createUser(values.name!, roles);
  console.log(JSON.stringify({ ...user, token }, null, 2));
  console.error("Save this token now; it is stored hashed and cannot be shown again.");
  await store.close();
} else if (command === "users" && sub === "list") {
  const store = await openStore();
  console.log(JSON.stringify({ whitelist: await store.listInvites(), users: await store.listUsers() }, null, 2));
  await store.close();
} else if (command === "hosting" && ["wg-peers", "egress-allowlist", "routes"].includes(sub ?? "")) {
  // Read by the gateway on the platform host to keep WireGuard, its egress proxy and the edge in step.
  const db = openDb();
  const store = await Store.open(db);
  const hosting = await HostingService.open(db, null, hostingConfigFromEnv());
  if (sub === "wg-peers") console.log(await hosting.wireguardPeers());
  else if (sub === "routes")
    console.log((await hosting.routes()).map((r) => `${r.host} {\n\treverse_proxy ${r.upstream}\n}\n`).join("\n"));
  else {
    const hosts = new Set<string>();
    const running = new Set((await hosting.tenants()).filter((t) => t.status === "running").map((t) => t.id));
    for (const h of await hosting.hostedApps()) if (running.has(h.tenant_id)) for (const host of await egressFor(store, hosting, h.app_id)) hosts.add(host);
    console.log([...hosts].sort().join("\n"));
  }
  await store.close();
} else if (command === "clerk" && sub === "setup") {
  const admin = clerkAdmin() ?? die("CLERK_SECRET_KEY is required");
  // Keep Clerk's allowlist in step with the whitelist (e.g. on a new production instance), and off
  // while public sign-up is on.
  const store = await openStore();
  const invites = await store.listInvites();
  const open = await store.publicSignup();
  await store.close();
  const warnings = await admin.setup({ allowlist: !open });
  for (const invite of invites) {
    const w = await admin.allow(invite.email);
    if (w) warnings.push(`${invite.email} ${w}`);
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(
    `Clerk: ${warnings.length ? "" : open ? "allowlist off (public sign-up), " : "allowlist on, "}dynamic client registration on, PKCE required, audience claims on; ` +
      `${invites.length} whitelisted email(s) synced to the allowlist`,
  );
} else {
  die(USAGE);
}
