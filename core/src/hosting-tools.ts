import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HostingCommandKind } from "./boxes.js";
import { isDirect } from "./freestyle.js";
import type { HostingService, Tenant } from "./hosting.js";
import { connectionApproval, requireApproved } from "./repo-approvals.js";
import { appProducts, buildTerms } from "./runtime.js";
import type { BuildService } from "./builds.js";
import type { Store, User } from "./store.js";
import { canSeeBuild, createdWorkspaces, memberApp, personalWorkspace, workspaceRole } from "./workspaces.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// What tenant VMs need to build images from source: GitHub (the verified commit), container and package
// registries.
export const BUILD_HOSTS = [
  "api.github.com",
  "codeload.github.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];

// Hosts a hosted app may reach through the gateway: the build hosts, Mynt's own API and the hand-off hosts
// of the products it uses.
export async function egressFor(store: Store, hosting: HostingService, appId: string): Promise<string[]> {
  const hosts = new Set<string>(BUILD_HOSTS);
  if (hosting.config) hosts.add(new URL(hosting.config.publicUrl).host);
  const app = await store.getApp(appId);
  if (app) {
    for (const p of await appProducts(store, app)) {
      const url = buildTerms(p).handoff_url;
      if (url) hosts.add(new URL(url).host);
    }
  }
  return [...hosts].sort();
}

// A compose app's service (e.g. api or web); omitted means all of them, or the first for a command.
const SERVICE = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/)
  .optional()
  .describe("For a compose app: the service (e.g. api or web)");

// The build a deployment runs: a build of the developer's workspace's app (or their own) that Mynt verified and pushed.
async function verifiedBuild(store: Store, user: User, buildId: string) {
  const r = await store.buildRun(buildId);
  if (!r || !(await canSeeBuild(store, user, r))) return { error: `No build of yours with id '${buildId}'` };
  if (r.status !== "succeeded" || !r.repository || !r.commit_sha) return { error: `Build '${buildId}' didn't pass Mynt's verification (status ${r.status}), so it can't be hosted` };
  return { build: { id: r.id, app_id: r.app_id, repository: r.repository, commit_sha: r.commit_sha } };
}

// A developer's view of their hosting: the VM and tunnel fields only mean something in the legacy gateway
// (WireGuard) mode; under direct hosting each app has its own VM, so they're left out.
export function developerTenant(tenant: Tenant, direct: boolean): Partial<Tenant> {
  if (!direct) return tenant;
  const { vm_id: _vm, tunnel_ip: _ip, wg_public_key: _wg, ...rest } = tenant;
  return rest;
}

// Hosting belongs to a workspace: its apps run on its tenant whoever deploys them, and only its owners and admins
// turn it on or log in to its VMs. A developer tenant from before workspaces keeps what it hosts until it's deployed
// again; logging in to it needs owner or admin standing in every workspace whose apps it still runs.
export function registerHostingTools(server: McpServer, store: Store, user: User, hosting: HostingService, builds: BuildService | null = null) {
  const WORKSPACE = z.string().optional().describe("The workspace (list_workspaces). Default: your own");
  // The named workspace if the caller is in it, else their own; `manage`: owners and admins only.
  const workspaceOf = async (id: string | undefined, manage: boolean): Promise<{ id: string } | { error: string }> => {
    const ws = id ?? (await createdWorkspaces(store.db, user.id))[0] ?? (manage ? await personalWorkspace(store.db, user.id) : null);
    if (!ws) return { error: "You have no workspace of your own yet; name one with workspace_id" };
    const role = await workspaceRole(store.db, ws, user.id);
    if (!role) return { error: `No workspace of yours with id '${ws}'` };
    if (manage && role === "member") return { error: "Only the workspace's owners and admins manage its hosting" };
    return { id: ws };
  };

  server.registerTool(
    "request_hosting",
    {
      title: "Get your isolated hosting",
      description:
        "Developer (a workspace's owners and admins): turn on hosting for a workspace's apps. Each app deployed gets its own VM, and each Compose service with a mynt.port label gets a public HTTPS address on the hosting provider's domain (e.g. https://mynt-<first 8 characters of the app id>.style.dev). The app's Mynt key is never stored on its VM: Mynt adds it at the edge to the app's calls to Mynt. Apps run there only from commits Mynt verified.",
      inputSchema: { workspace_id: WORKSPACE },
    },
    async ({ workspace_id }) => {
      if (!hosting.enabled) return fail("Hosting isn't configured on this deployment yet");
      const ws = await workspaceOf(workspace_id, true);
      if ("error" in ws) return fail(ws.error);
      const tenant = await hosting.provisionWorkspace(ws.id);
      await store.audit(user.id, "request_hosting", tenant.id, { status: tenant.status, workspace_id: ws.id });
      return json(developerTenant(tenant, isDirect(hosting.provider)));
    },
  );

  server.registerTool(
    "hosting_status",
    {
      title: "Your hosting",
      description: "Developer: a workspace's hosting: its status, the apps it hosts (at which verified commit, on which port) and the public address of each app and service.",
      inputSchema: { workspace_id: WORKSPACE },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const ws = await workspaceOf(workspace_id, false);
      if ("error" in ws) return fail(ws.error);
      const tenant = await hosting.tenantOfWorkspace(ws.id);
      // The workspace's apps still on a developer's hosting from before workspaces, until they're deployed again.
      const legacy = (
        await store.db.query(
          `SELECT h.app_id::text AS app_id, h.status, h.commit_sha, h.updated_at FROM financial_products.hosted_apps h
           JOIN financial_products.apps a ON a.id = h.app_id JOIN financial_products.hosting_tenants t ON t.id = h.tenant_id
           WHERE a.workspace_id::text = $1 AND t.workspace_id IS NULL`,
          [ws.id],
        )
      ).rows.map((r) => ({ ...(r as Record<string, unknown>), legacy: true }));
      if (!tenant) return json({ tenant: null, apps: legacy });
      const routes = await hosting.routes();
      const apps = (await hosting.hostedApps(tenant.id)).map((h) => {
        const route = routes.find((r) => r.upstream === `${tenant.tunnel_ip}:${h.port}`);
        const direct = hosting.provider && "direct" in hosting.provider ? hosting.appDomain(h.app_id) : null;
        const services = h.services?.map((x) => ({ ...x, url: x.domain ? `https://${x.domain}` : null }));
        return { ...h, ...(services ? { services } : {}), url: route ? `https://${route.host}` : direct ? `https://${direct}` : null };
      });
      return json({ tenant: developerTenant(tenant, isDirect(hosting.provider)), apps: [...apps, ...legacy], usage: await hosting.usage(tenant) });
    },
  );

  server.registerTool(
    "deploy_app",
    {
      title: "Host an app",
      description:
        "Developer: run one of your apps on its own VM from a build Mynt verified (build_id from your coding-agent builds). The VM fetches exactly that commit, builds it and runs it; each Compose service listens on the port its mynt.port label names and is served publicly over HTTPS. Mynt gives the app a dedicated key (live once the app is published, else sandbox), added at the edge to its calls to Mynt and never stored on the VM. Deploying again with a newer build replaces it.",
      inputSchema: { app_id: z.string(), build_id: z.string() },
    },
    async ({ app_id, build_id }) => {
      if (!hosting.enabled) return fail("Hosting isn't configured on this deployment yet");
      const app = await memberApp(store, user, app_id);
      if (!app) return fail(`No app of yours with id '${app_id}'`);
      // The app's workspace's hosting, whoever deploys it.
      const tenant = app.workspace_id ? await hosting.tenantOfWorkspace(app.workspace_id) : await hosting.tenantOf(user.id);
      if (!tenant) return fail("The workspace has no hosting yet: an owner or admin turns it on (request_hosting)");
      if (tenant.status !== "running") return fail(`The workspace's hosting is ${tenant.status}`);
      const found = await verifiedBuild(store, user, build_id);
      if ("error" in found) return fail(found.error!);
      if (found.build.app_id && found.build.app_id !== app_id) return fail(`Build '${build_id}' was for another app`);
      // A teammate's build of this app in its managed repository: the deployer gets the same access its builders have.
      if (builds) await builds.ensureManagedConnection(user.id, app_id, found.build.repository).catch(() => undefined);
      // Hosting fetches the source through the developer's connection to the repository: only once an admin approved it.
      try {
        requireApproved(await connectionApproval(store.db, user.id, found.build.repository), found.build.repository);
      } catch (e) {
        return fail((e as Error).message);
      }
      const environment = app.status === "published" ? "live" : "sandbox";
      let plan;
      try {
        plan = await hosting.planSource(user.id, found.build.repository, found.build.commit_sha);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (plan.check?.errors.length) return fail(`Mynt can't host this compose file: ${plan.check.errors.join("; ")}`);
      if (plan.composeFile && !(hosting.provider && "direct" in hosting.provider)) return fail("Compose apps need direct hosting (Freestyle), which isn't configured here");
      const egress = await egressFor(store, hosting, app_id);
      const { key: runtimeKey, secret } = await store.createApiKey(user.id, { app_id, environment, label: "hosted runtime", allowed_origins: [] });
      // Sealed for the edge and never shown: the workspace's, not the deployer's (their leaving doesn't stop the app).
      await store.db.query("UPDATE financial_products.api_keys SET created_by = NULL, last_secret_issued_to = NULL WHERE id = $1", [runtimeKey.id]);
      const hosted = await hosting.deploy(tenant, app, found.build, secret, environment === "sandbox", egress, plan, user.id);
      await store.audit(user.id, "deploy_app", app_id, { build_id, commit_sha: found.build.commit_sha, environment });
      const domain = hosting.appDomain(app_id);
      return json({
        ...hosted,
        environment,
        egress,
        url: domain ? `https://${domain}` : null,
        ...(hosted.services ? { services: hosted.services.map((x) => ({ ...x, url: x.domain ? `https://${x.domain}` : null })) } : {}),
      });
    },
  );

  server.registerTool(
    "undeploy_app",
    {
      title: "Stop hosting an app",
      description: "Developer: stop hosting one of your apps; its public addresses go away and, under direct hosting, its VM is deleted.",
      inputSchema: { app_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ app_id }) => {
      if (!(await memberApp(store, user, app_id))) return fail(`No app of yours with id '${app_id}'`);
      if (!(await hosting.undeploy(app_id))) return fail(`'${app_id}' isn't hosted`);
      await store.audit(user.id, "undeploy_app", app_id);
      return json({ app_id, hosted: false });
    },
  );

  server.registerTool(
    "vm_access",
    {
      title: "Log in to your hosting VM",
      description:
        "Developer (a workspace's owners and admins): SSH logins to the workspace's hosted apps' VMs (each app has its own) as a Linux user (in the docker group, no sudo), valid for a few hours; new logins revoke the last ones, and so does anyone leaving the workspace. Paste a command in a terminal, or use it as a VS Code Remote-SSH host. Keep them private: they're credentials. Apps' Mynt keys aren't on the VMs (they're added to calls to Mynt on the way out).",
      inputSchema: { hours: z.number().int().min(1).max(24).default(8), workspace_id: WORKSPACE, legacy: z.boolean().default(false).describe("Your own hosting from before workspaces, instead") },
    },
    async ({ hours, workspace_id, legacy }) => {
      let tenant;
      if (legacy) {
        // Your own tenant from before workspaces: only while you're an owner or admin of every workspace it serves.
        tenant = await hosting.tenantOf(user.id);
        if (!tenant) return fail("You have no hosting of your own from before workspaces");
        const served = (
          await store.db.query(
            "SELECT DISTINCT a.workspace_id::text AS ws FROM financial_products.hosted_apps h JOIN financial_products.apps a ON a.id = h.app_id WHERE h.tenant_id = $1",
            [tenant.id],
          )
        ).rows as { ws: string | null }[];
        for (const { ws } of served) {
          const role = ws ? await workspaceRole(store.db, ws, user.id) : null;
          if (role !== "owner" && role !== "admin") return fail("That VM runs apps of a workspace you're no longer an owner or admin of; ask its owners to redeploy them");
        }
      } else {
        const ws = await workspaceOf(workspace_id, true);
        if ("error" in ws) return fail(ws.error);
        tenant = await hosting.tenantOfWorkspace(ws.id);
        if (!tenant) return fail("The workspace has no hosting yet (request_hosting)");
      }
      try {
        const access = await hosting.vmAccess(tenant, hours, user.id);
        await store.audit(user.id, "vm_access", tenant.id, { hours });
        return json({ ...access, user: "developer", note: "Your apps run as containers named mynt-app-<id>: docker ps, docker logs, docker exec." });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // The VM the app runs on: the developer asks, the VM's agent does it within a few seconds over the tunnel.
  // Nothing reaches the VM from outside; commands only ever touch the developer's own app containers.
  // A workspace's app runs on the VM of whoever deployed it: commands go there, for any member of the workspace.
  const onVm = async (app_id: string, kind: HostingCommandKind, args: Record<string, unknown>, waitSeconds: number) => {
    const app = await memberApp(store, user, app_id);
    if (!app) return fail(`No app of yours with id '${app_id}'`);
    const tenant = (await hosting.tenantHostingApp(app_id)) ?? (app.workspace_id ? await hosting.tenantOfWorkspace(app.workspace_id) : await hosting.tenantOf(user.id));
    if (!tenant) return fail("You have no hosting yet (request_hosting)");
    try {
      const queued = await hosting.queueCommand(tenant, app_id, kind, args, user.id);
      await store.audit(user.id, `app_${kind}`, app_id, kind === "exec" ? { command: args.command } : args);
      const c = await hosting.waitForCommand(queued.id, waitSeconds * 1000);
      if (c.status === "done") return json({ app_id, kind, exit_code: c.exit_code, output: c.output });
      return fail(c.status === "expired" ? "Your VM didn't pick this up; it may be offline (hosting_status)" : `Your VM hasn't answered within ${waitSeconds}s; try again shortly`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  server.registerTool(
    "app_status",
    {
      title: "How a hosted app is doing",
      description: "Developer: your hosted app on your VM, each Compose service (or its one container): running or not, since when, health, how many times it restarted, image (the verified commit), CPU and memory.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => onVm(app_id, "status", {}, 30),
  );

  server.registerTool(
    "app_logs",
    {
      title: "A hosted app's logs",
      description: "Developer: the latest log lines of your hosted app, with timestamps. Secrets are scrubbed.",
      inputSchema: { app_id: z.string(), tail: z.number().int().min(1).max(2000).default(200), service: SERVICE },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id, tail, service }) => onVm(app_id, "logs", { tail, ...(service ? { service } : {}) }, 30),
  );

  server.registerTool(
    "app_run",
    {
      title: "Run a command in a hosted app",
      description:
        "Developer: run a shell command inside your hosted app's container (under gVisor, read-only apart from /tmp), e.g. 'node --version' or 'wget -qO- localhost:<your mynt.port>/healthz'. It never runs on the VM itself. Output is capped and secrets are scrubbed; every command is audited.",
      inputSchema: { app_id: z.string(), command: z.string().min(1).max(4000), timeout_seconds: z.number().int().min(1).max(120).default(30), service: SERVICE },
    },
    async ({ app_id, command, timeout_seconds, service }) => onVm(app_id, "exec", { command, timeout_seconds, ...(service ? { service } : {}) }, timeout_seconds + 15),
  );

  server.registerTool(
    "restart_app",
    {
      title: "Restart a hosted app",
      description: "Developer: restart your hosted app's container on your VM (same verified commit).",
      inputSchema: { app_id: z.string(), service: SERVICE },
    },
    async ({ app_id, service }) => onVm(app_id, "restart", service ? { service } : {}, 60),
  );
}

export function registerHostingAdminTools(server: McpServer, store: Store, user: User, hosting: HostingService) {
  server.registerTool(
    "list_tenants",
    {
      title: "Hosting tenants",
      description: "Admin: every developer's hosting VM, its status and tunnel address, and the apps it runs.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await Promise.all((await hosting.tenants()).map(async (t) => ({ ...t, apps: await hosting.hostedApps(t.id), usage: await hosting.usage(t) })))),
  );

  for (const [name, action, description] of [
    ["suspend_tenant", "suspend", "Admin: the kill switch. Cuts a developer's VM off at once (its tunnel, routes and egress are dropped from the gateway) and powers it off. Resume with resume_tenant."],
    ["resume_tenant", "resume", "Admin: put a suspended developer's VM back on the gateway and power it on."],
  ] as const) {
    server.registerTool(
      name,
      { title: name.replace("_", " "), description, inputSchema: { tenant_id: z.string(), reason: z.string().min(3).optional() }, ...(action === "suspend" ? { annotations: { destructiveHint: true } } : {}) },
      async ({ tenant_id, reason }) => {
        const t = action === "suspend" ? await hosting.suspend(tenant_id) : await hosting.resume(tenant_id);
        if (!t) return fail(`No ${action === "resume" ? "suspended " : ""}tenant '${tenant_id}'`);
        await store.audit(user.id, name, tenant_id, { reason });
        return json(t);
      },
    );
  }
}
