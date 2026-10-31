import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HostingCommandKind } from "./boxes.js";
import type { HostingService } from "./hosting.js";
import { appProducts, buildTerms } from "./runtime.js";
import type { Store, User } from "./store.js";

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

// The build a deployment runs: one of the developer's builds that Mynt verified and pushed.
async function verifiedBuild(store: Store, developerId: string, buildId: string) {
  const r = await store.buildRun(buildId);
  if (!r || r.developer_id !== developerId) return { error: `No build of yours with id '${buildId}'` };
  if (r.status !== "succeeded" || !r.repository || !r.commit_sha) return { error: `Build '${buildId}' didn't pass Mynt's verification (status ${r.status}), so it can't be hosted` };
  return { build: { id: r.id, app_id: r.app_id, repository: r.repository, commit_sha: r.commit_sha } };
}

export function registerHostingTools(server: McpServer, store: Store, user: User, hosting: HostingService) {
  server.registerTool(
    "request_hosting",
    {
      title: "Get your isolated hosting",
      description:
        "Developer: create your own VM for hosting your apps' financial part (the server that holds the app key and calls contract actions). It's never reachable from the internet or the platform's network: it boots, registers with Mynt, and from then on talks only through an encrypted tunnel to Mynt's gateway, which lets it reach Mynt's API and its products' hand-off hosts and nothing else. Apps run there from commits Mynt verified, under gVisor.",
      inputSchema: {},
    },
    async () => {
      if (!hosting.enabled) return fail("Hosting isn't configured on this deployment yet");
      const tenant = await hosting.provision(user.id);
      await store.audit(user.id, "request_hosting", tenant.id, { status: tenant.status });
      return json(tenant);
    },
  );

  server.registerTool(
    "hosting_status",
    {
      title: "Your hosting",
      description: "Developer: your VM's status and tunnel address, the apps it runs (at which verified commit) and where each is served.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const tenant = await hosting.tenantOf(user.id);
      if (!tenant) return json({ tenant: null, apps: [] });
      const routes = await hosting.routes();
      const apps = (await hosting.hostedApps(tenant.id)).map((h) => {
        const route = routes.find((r) => r.upstream === `${tenant.tunnel_ip}:${h.port}`);
        const direct = hosting.provider && "direct" in hosting.provider ? hosting.appDomain(h.app_id) : null;
        const services = h.services?.map((x) => ({ ...x, url: x.domain ? `https://${x.domain}` : null }));
        return { ...h, ...(services ? { services } : {}), url: route ? `https://${route.host}` : direct ? `https://${direct}` : null };
      });
      return json({ tenant, apps, usage: await hosting.usage(tenant) });
    },
  );

  server.registerTool(
    "deploy_app",
    {
      title: "Host an app",
      description:
        "Developer: run one of your apps on your VM from a build Mynt verified (build_id from your coding-agent builds). Mynt gives it a dedicated app key (live once the app is published, else sandbox) and the VM fetches exactly that commit, builds it and runs it under gVisor, listening on port 8080 inside its container. Deploying again with a newer build replaces it.",
      inputSchema: { app_id: z.string(), build_id: z.string() },
    },
    async ({ app_id, build_id }) => {
      if (!hosting.enabled) return fail("Hosting isn't configured on this deployment yet");
      const app = await store.getApp(app_id);
      if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
      const tenant = await hosting.tenantOf(user.id);
      if (!tenant) return fail("Request your hosting first (request_hosting)");
      if (tenant.status !== "running") return fail(`Your hosting is ${tenant.status}`);
      const found = await verifiedBuild(store, user.id, build_id);
      if ("error" in found) return fail(found.error!);
      if (found.build.app_id && found.build.app_id !== app_id) return fail(`Build '${build_id}' was for another app`);
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
      const { secret } = await store.createApiKey(user.id, { app_id, environment, label: "hosted runtime", allowed_origins: [] });
      const hosted = await hosting.deploy(tenant, app, found.build, secret, environment === "sandbox", egress, plan);
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
      description: "Developer: stop running one of your apps on your VM; the agent removes it on its next check (within 30 seconds).",
      inputSchema: { app_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ app_id }) => {
      const app = await store.getApp(app_id);
      if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
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
        "Developer: SSH logins to your hosted apps' VMs (each app has its own) as your own Linux user (in the docker group, no sudo), valid for a few hours; new logins revoke the last ones. Paste a command in a terminal, or use it as a VS Code Remote-SSH host. Keep them private: they're credentials. Apps' Mynt keys aren't on the VMs (they're added to calls to Mynt on the way out).",
      inputSchema: { hours: z.number().int().min(1).max(24).default(8) },
    },
    async ({ hours }) => {
      const tenant = await hosting.tenantOf(user.id);
      if (!tenant) return fail("You have no hosting yet (request_hosting)");
      try {
        const access = await hosting.vmAccess(tenant, hours);
        await store.audit(user.id, "vm_access", tenant.id, { hours });
        return json({ ...access, user: "developer", note: "Your apps run as containers named mynt-app-<id>: docker ps, docker logs, docker exec." });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // The VM the app runs on: the developer asks, the VM's agent does it within a few seconds over the tunnel.
  // Nothing reaches the VM from outside; commands only ever touch the developer's own app containers.
  const onVm = async (app_id: string, kind: HostingCommandKind, args: Record<string, unknown>, waitSeconds: number) => {
    const app = await store.getApp(app_id);
    if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
    const tenant = await hosting.tenantOf(user.id);
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
      description: "Developer: your hosted app's container on your VM: running or not, since when, health, restarts, image (the verified commit), CPU and memory.",
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
        "Developer: run a shell command inside your hosted app's container (under gVisor, read-only apart from /tmp), e.g. 'node --version' or 'wget -qO- localhost:8080/healthz'. It never runs on the VM itself. Output is capped and secrets are scrubbed; every command is audited.",
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
