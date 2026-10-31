import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { seal, open } from "./vault.js";
import { boxOutput, type HostingCommandKind } from "./boxes.js";
import { FreestyleProvider, isDirect, type DirectHostingProvider } from "./freestyle.js";
import { checkCompose, composeOverride, COMPOSE_FILES, type ComposeCheck } from "./compose.js";

// Hosted runtime: developers' apps (their financial part: the server that holds the app key, calls
// contract actions and handles webhooks) run on an isolated VM per developer, built from the exact commit
// Mynt verified. A VM is never reachable from the internet and never on the platform's network:
//
// - It boots, installs Docker, gVisor and WireGuard, generates its own WireGuard key (the private key never
//   leaves it), and registers with a one-time bootstrap token. Mynt gives it a tunnel address and an agent
//   token, and locks its cloud firewall down to WireGuard to the gateway, nothing else, in or out.
// - All its traffic goes through the tunnel. The gateway (on the platform host) only routes it to Mynt's
//   runtime API and the hosts the app's products declare (their hand-off URLs): the egress allowlist.
// - Its agent polls its policy over the tunnel: which apps to run, at which verified commit, with a
//   short-lived read-only token to fetch that commit and the app's dedicated key. Apps run under gVisor,
//   read-only, without capabilities, on 127.0.0.1; customers reach them through Mynt's edge and the tunnel.
// - The kill switch (an admin suspends a tenant, or a developer undeploys) drops the tenant from the
//   gateway's peers, routes and allowlist at once and powers its VM off.

export const TENANT_STATUSES = ["provisioning", "running", "suspended", "failed"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
const TUNNEL_PREFIX = "10.88"; // tenants get 10.88.x.y/32; the gateway is 10.88.0.1
const GATEWAY_TUNNEL_IP = `${TUNNEL_PREFIX}.0.1`;
const PROXY_PORT = 8888; // the gateway's egress proxy (CONNECT to allowlisted hosts only)

export interface VmSpec {
  name: string;
  region: string;
  size: string;
  userData: string;
  tags: string[];
}
export interface HostingProvider {
  readonly name: string;
  createVm(spec: VmSpec): Promise<{ id: string }>;
  // Inbound: nothing. Outbound: WireGuard (UDP) to the gateway only.
  lockDown(vmId: string, gatewayIp: string, wireguardPort: number): Promise<void>;
  powerOff(vmId: string): Promise<void>;
  powerOn(vmId: string): Promise<void>;
  deleteVm(vmId: string): Promise<void>;
}

// DigitalOcean: one droplet per tenant, tagged, with its own cloud firewall once it has registered.
export class DigitalOceanProvider implements HostingProvider {
  readonly name = "digitalocean";
  constructor(
    private readonly token: string,
    private readonly opts: { image?: string; fetch?: typeof fetch } = {},
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await (this.opts.fetch ?? fetch)(`https://api.digitalocean.com/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DigitalOcean ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async createVm(spec: VmSpec) {
    const r = await this.call("POST", "/droplets", {
      name: spec.name,
      region: spec.region,
      size: spec.size,
      image: this.opts.image ?? "ubuntu-24-04-x64",
      user_data: spec.userData,
      tags: spec.tags,
      ipv6: false,
      monitoring: true,
    });
    return { id: String(r.droplet.id) };
  }

  async lockDown(vmId: string, gatewayIp: string, wireguardPort: number) {
    await this.call("POST", "/firewalls", {
      name: `mynt-tenant-${vmId}`,
      inbound_rules: [],
      outbound_rules: [{ protocol: "udp", ports: String(wireguardPort), destinations: { addresses: [`${gatewayIp}/32`] } }],
      droplet_ids: [Number(vmId)],
    });
  }

  async powerOff(vmId: string) {
    await this.call("POST", `/droplets/${vmId}/actions`, { type: "power_off" });
  }

  async powerOn(vmId: string) {
    await this.call("POST", `/droplets/${vmId}/actions`, { type: "power_on" });
  }

  async deleteVm(vmId: string) {
    await this.call("DELETE", `/droplets/${vmId}`);
  }
}

export interface HostingConfig {
  publicUrl: string; // where VMs reach Mynt (bootstrap, policy) through the tunnel
  gatewayEndpoint: string; // host:port of the gateway's WireGuard
  gatewayPublicKey: string;
  gatewayIp: string; // the gateway's public IP, the only address tenants may send to
  region: string;
  size: string;
  appsDomain: string | null; // apps are served at <app>.<appsDomain>
}

export function hostingConfigFromEnv(env = process.env): HostingConfig | null {
  if (env.FREESTYLE_API_KEY && env.PUBLIC_URL)
    return {
      publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
      gatewayEndpoint: "",
      gatewayPublicKey: "",
      gatewayIp: "",
      region: env.HOSTING_REGION ?? "",
      size: env.HOSTING_SIZE ?? "",
      appsDomain: env.HOSTING_APPS_DOMAIN ?? null,
    };
  const need = ["HOSTING_GATEWAY_ENDPOINT", "HOSTING_GATEWAY_PUBLIC_KEY", "PUBLIC_URL"];
  if (need.some((k) => !env[k])) return null;
  const endpoint = env.HOSTING_GATEWAY_ENDPOINT!;
  return {
    publicUrl: env.PUBLIC_URL!.replace(/\/+$/, ""),
    gatewayEndpoint: endpoint,
    gatewayPublicKey: env.HOSTING_GATEWAY_PUBLIC_KEY!,
    gatewayIp: env.HOSTING_GATEWAY_IP ?? endpoint.split(":")[0],
    region: env.HOSTING_REGION ?? "blr1",
    size: env.HOSTING_SIZE ?? "s-1vcpu-2gb",
    appsDomain: env.HOSTING_APPS_DOMAIN ?? null,
  };
}

export function hostingProviderFromEnv(env = process.env): HostingProvider | DirectHostingProvider | null {
  if (env.FREESTYLE_API_KEY) return new FreestyleProvider(env.FREESTYLE_API_KEY);
  return env.HOSTING_DO_TOKEN ? new DigitalOceanProvider(env.HOSTING_DO_TOKEN, { image: env.HOSTING_DO_IMAGE }) : null;
}

export interface Tenant {
  id: string;
  developer_id: string;
  provider: string;
  vm_id: string | null;
  status: TenantStatus;
  tunnel_ip: string | null;
  wg_public_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export interface HostedApp {
  app_id: string;
  tenant_id: string;
  build_id: string;
  repository: string;
  commit_sha: string;
  port: number;
  status: "deploying" | "running" | "stopped";
  error?: string | null;
  // A compose app: the services Mynt serves, each on its own VM port and address.
  services?: HostedService[];
  updated_at: string;
}
export interface HostedService {
  service: string;
  expose: string;
  port: number; // on the VM
  domain: string | null;
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.hosting_tenants (
    id uuid PRIMARY KEY,
    developer_id uuid NOT NULL UNIQUE REFERENCES financial_products.users(id),
    provider text NOT NULL,
    vm_id text,
    status text NOT NULL CHECK (status IN ('provisioning', 'running', 'suspended', 'failed')),
    tunnel_index integer UNIQUE,
    wg_public_key text UNIQUE,
    bootstrap_hash text,
    bootstrap_expires_at timestamptz,
    agent_hash text UNIQUE,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.hosted_apps (
    app_id uuid PRIMARY KEY REFERENCES financial_products.apps(id),
    tenant_id uuid NOT NULL REFERENCES financial_products.hosting_tenants(id),
    build_id uuid NOT NULL,
    repository text NOT NULL,
    commit_sha text NOT NULL,
    port integer NOT NULL,
    app_key_sealed text NOT NULL,
    status text NOT NULL CHECK (status IN ('deploying', 'running', 'stopped')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, port)
  );
  -- What the developer asked their VM to do (status, logs, restart, exec in one of their app containers); the
  -- VM's agent claims them over the tunnel and reports back.
  CREATE TABLE IF NOT EXISTS financial_products.hosting_commands (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES financial_products.hosting_tenants(id),
    app_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('status', 'logs', 'restart', 'exec')),
    args jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'expired')),
    exit_code integer,
    output text,
    requested_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  ALTER TABLE financial_products.hosting_tenants ADD COLUMN IF NOT EXISTS access_identity text;
  ALTER TABLE financial_products.hosted_apps ADD COLUMN IF NOT EXISTS egress jsonb;
  ALTER TABLE financial_products.hosted_apps ADD COLUMN IF NOT EXISTS error text;
  ALTER TABLE financial_products.hosted_apps ADD COLUMN IF NOT EXISTS compose_file text;
  ALTER TABLE financial_products.hosted_apps ADD COLUMN IF NOT EXISTS services jsonb;
  CREATE INDEX IF NOT EXISTS hosting_commands_tenant_idx ON financial_products.hosting_commands (tenant_id, status, created_at);
`;

// First boot of a direct VM: the developer's own Linux user (docker, no sudo).
const DIRECT_SETUP = `set -e
id developer >/dev/null 2>&1 || sudo -n useradd --create-home --shell /bin/bash developer
sudo -n usermod -aG docker developer
docker version --format '{{.Server.Version}}'`;

// Builds the verified commit and runs it: a compose app as a project with Mynt's override on top, otherwise its
// Dockerfile, hardened. NAME, SHA, PORT, SOURCE_URL, SOURCE_TOKEN, COMPOSE_FILE_NAME, COMPOSE_OVERRIDE and the
// MYNT_* settings come from the environment.
const DIRECT_DEPLOY = `set -euo pipefail
DIR="$HOME/apps/$NAME/$SHA"
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR.tmp"
  curl -fsSL -H "Authorization: Bearer $SOURCE_TOKEN" "$SOURCE_URL" | tar -xz -C "$DIR.tmp" --strip-components=1
  mv "$DIR.tmp" "$DIR"
fi
cd "$DIR"
if [ -n "$COMPOSE_FILE_NAME" ]; then
  printf '%s' "$COMPOSE_OVERRIDE" > .mynt-override.json
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker compose -p "$NAME" -f "$COMPOSE_FILE_NAME" -f .mynt-override.json up -d --build --remove-orphans --wait --wait-timeout 300
else
  IMG="mynt/$NAME:$SHA"
  docker image inspect "$IMG" >/dev/null 2>&1 || docker build -q -t "$IMG" . >/dev/null
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL \\
    --security-opt no-new-privileges --memory 1g --cpus 1 -p "$PORT:8080" -e MYNT_API_KEY -e MYNT_BASE_URL "$IMG" >/dev/null
fi
ls -1dt "$HOME/apps/$NAME"/*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf
echo "running $NAME at $SHA"`;

// The same commands the tunnel agent runs, for a direct VM: against the compose project when the app is one
// (a service can be named in $SERVICE), otherwise its container. exec's command arrives as $CMD.
export function directCommand(kind: HostingCommandKind, name: string, args: Record<string, unknown>): string {
  if (!/^mynt-app-[0-9a-f]{8}$/.test(name)) throw new Error("Not an app container");
  const tail = Math.max(1, Math.min(2000, Number(args.tail ?? 200)));
  const timeout = Math.max(1, Math.min(120, Number(args.timeout_seconds ?? 60)));
  const project = `[ -n "$(docker compose -p ${name} ps -aq 2>/dev/null)" ]`;
  const cmd: Record<HostingCommandKind, [string, string]> = {
    status: [
      `docker compose -p ${name} ps --format '{{.Service}}: {{.State}} {{.Status}}' && docker stats --no-stream --format '{{.Name}}: {{.CPUPerc}} CPU, {{.MemUsage}} memory' $(docker compose -p ${name} ps -q)`,
      `docker inspect -f '{{.State.Status}} since {{.State.StartedAt}}, health {{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}, restarts {{.RestartCount}}, image {{.Config.Image}}' ${name} && docker stats --no-stream --format '{{.CPUPerc}} CPU, {{.MemUsage}} memory' ${name}`,
    ],
    logs: [`docker compose -p ${name} logs --timestamps --tail ${tail} $SERVICE`, `docker logs --timestamps --tail ${tail} ${name}`],
    restart: [`docker compose -p ${name} restart $SERVICE`, `docker restart ${name}`],
    exec: [
      `timeout ${timeout} docker compose -p ${name} exec -T "\${SERVICE:-$(docker compose -p ${name} ps --services | head -1)}" sh -c "$CMD"`,
      `timeout ${timeout} docker exec ${name} sh -c "$CMD"`,
    ],
  };
  const [compose, single] = cmd[kind];
  return `if ${project}; then ${compose}; else ${single}; fi 2>&1`;
}

// The container an app runs in on its VM.
export const containerName = (appId: string) => `mynt-app-${appId.slice(0, 8)}`;
export interface HostingCommand {
  id: string;
  app_id: string;
  kind: HostingCommandKind;
  args: Record<string, unknown>;
  status: "queued" | "running" | "done" | "expired";
  exit_code: number | null;
  output: string | null;
  created_at: string;
  finished_at: string | null;
}
const toCommand = (r: Record<string, unknown>): HostingCommand => ({
  id: r.id as string,
  app_id: r.app_id as string,
  kind: r.kind as HostingCommandKind,
  args: (typeof r.args === "string" ? JSON.parse(r.args) : r.args) as Record<string, unknown>,
  status: r.status as HostingCommand["status"],
  exit_code: (r.exit_code as number | null) ?? null,
  output: (r.output as string | null) ?? null,
  created_at: iso(r.created_at)!,
  finished_at: iso(r.finished_at),
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const tunnelIp = (index: number | null) => (index == null ? null : `${TUNNEL_PREFIX}.${Math.floor(index / 250) + 1}.${(index % 250) + 2}`);
const toTenant = (r: Record<string, unknown>): Tenant => ({
  id: r.id as string,
  developer_id: r.developer_id as string,
  provider: r.provider as string,
  vm_id: (r.vm_id as string | null) ?? null,
  status: r.status as TenantStatus,
  tunnel_ip: tunnelIp((r.tunnel_index as number | null) ?? null),
  wg_public_key: (r.wg_public_key as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});
const toHostedApp = (r: Record<string, unknown>): HostedApp => ({
  app_id: r.app_id as string,
  tenant_id: r.tenant_id as string,
  build_id: r.build_id as string,
  repository: r.repository as string,
  commit_sha: r.commit_sha as string,
  port: Number(r.port),
  status: r.status as HostedApp["status"],
  ...(r.error ? { error: r.error as string } : {}),
  ...(r.services ? { services: (typeof r.services === "string" ? JSON.parse(r.services) : r.services) as HostedService[] } : {}),
  updated_at: iso(r.updated_at)!,
});

// What a VM runs at first boot: it installs its runtime, makes its own WireGuard key, registers, brings up
// the tunnel with all traffic through it, and starts the agent loop that reconciles apps from its policy.
export function tenantUserData(cfg: HostingConfig, bootstrapToken: string): string {
  return `#!/bin/bash
# Mynt tenant VM: no inbound access; everything goes through the WireGuard tunnel to the gateway.
set -euo pipefail
exec >>/var/log/mynt-tenant.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io wireguard-tools jq curl
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" >/etc/apt/sources.list.d/gvisor.list
apt-get update -q && apt-get install -yq runsc
runsc install && systemctl restart docker
umask 077
mkdir -p /etc/mynt
wg genkey | tee /etc/mynt/wg.key | wg pubkey >/etc/mynt/wg.pub
REG=$(curl -fsS -X POST ${cfg.publicUrl}/v1/hosting/bootstrap -H 'Content-Type: application/json' \\
  -d "{\\"token\\":\\"${bootstrapToken}\\",\\"wg_public_key\\":\\"$(cat /etc/mynt/wg.pub)\\"}")
echo "$REG" | jq -r .agent_token >/etc/mynt/agent.token
cat >/etc/wireguard/wg0.conf <<WG
[Interface]
Address = $(echo "$REG" | jq -r .tunnel_ip)/32
PrivateKey = $(cat /etc/mynt/wg.key)
[Peer]
PublicKey = ${cfg.gatewayPublicKey}
Endpoint = ${cfg.gatewayEndpoint}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
WG
systemctl enable --now wg-quick@wg0
# Image builds pull through the gateway's proxy too.
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment=HTTPS_PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT} HTTP_PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT}\n' >/etc/systemd/system/docker.service.d/proxy.conf
systemctl daemon-reload && systemctl restart docker
cat >/usr/local/bin/mynt-agent <<'AGENT'
#!/bin/bash
# Reconciles the apps this VM runs with its policy from Mynt, every 30 seconds.
set -uo pipefail
PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT}
while true; do
  POLICY=$(curl -fsS -x "$PROXY" ${cfg.publicUrl}/v1/hosting/policy -H "Authorization: Bearer $(cat /etc/mynt/agent.token)") || { sleep 30; continue; }
  WANT=$(echo "$POLICY" | jq -r '.apps[].name')
  for c in $(docker ps -a --format '{{.Names}}' | grep '^mynt-app-' || true); do
    echo "$WANT" | grep -qx "$c" || docker rm -f "$c"
  done
  echo "$POLICY" | jq -c '.apps[]' | while read -r app; do
    NAME=$(echo "$app" | jq -r .name); SHA=$(echo "$app" | jq -r .commit_sha); IMG="mynt/$NAME:$SHA"
    if ! docker image inspect "$IMG" >/dev/null 2>&1; then
      DIR=$(mktemp -d)
      curl -fsSL -x "$PROXY" -H "Authorization: Bearer $(echo "$app" | jq -r .source_token)" "$(echo "$app" | jq -r .source_url)" | tar -xz -C "$DIR" --strip-components=1
      docker build -q -t "$IMG" "$DIR" && rm -rf "$DIR"
    fi
    if [ "$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null)" != "$IMG" ]; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" --restart unless-stopped --runtime runsc --read-only --tmpfs /tmp \\
        --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 0.5 \\
        -p "$(echo "$app" | jq -r .tunnel_ip):$(echo "$app" | jq -r .port):8080" \\
        -e HTTPS_PROXY="$PROXY" -e HTTP_PROXY="$PROXY" \\
        -e MYNT_API_KEY="$(echo "$app" | jq -r .app_key)" -e MYNT_BASE_URL="$(echo "$app" | jq -r .mynt_base_url)" "$IMG"
    fi
  done
  sleep 30
done
AGENT
chmod 700 /usr/local/bin/mynt-agent
cat >/usr/local/bin/mynt-agent-commands <<'AGENT'
#!/bin/bash
# Runs what the developer asked for (status, logs, restart, exec) against their own app containers only, every
# few seconds. exec runs inside the app's container, under gVisor, never on this VM.
set -uo pipefail
PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT}
AUTH="Authorization: Bearer $(cat /etc/mynt/agent.token)"
while true; do
  CMDS=$(curl -fsS -x "$PROXY" ${cfg.publicUrl}/v1/hosting/commands -H "$AUTH") || { sleep 5; continue; }
  echo "$CMDS" | jq -c '.commands[]' | while read -r c; do
    ID=$(echo "$c" | jq -r .id); NAME=$(echo "$c" | jq -r .container); KIND=$(echo "$c" | jq -r .kind)
    echo "$NAME" | grep -Eqx 'mynt-app-[0-9a-f]{8}' || continue
    case "$KIND" in
      status) OUT=$(docker inspect -f '{{.State.Status}} since {{.State.StartedAt}}, health {{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}, restarts {{.RestartCount}}, image {{.Config.Image}}' "$NAME" 2>&1 && docker stats --no-stream --format '{{.CPUPerc}} CPU, {{.MemUsage}} memory' "$NAME" 2>&1); RC=$? ;;
      logs) OUT=$(docker logs --timestamps --tail "$(echo "$c" | jq -r '.args.tail // 200')" "$NAME" 2>&1); RC=$? ;;
      restart) OUT=$(docker restart "$NAME" 2>&1); RC=$? ;;
      exec) OUT=$(timeout "$(echo "$c" | jq -r '.args.timeout_seconds // 60')" docker exec "$NAME" sh -c "$(echo "$c" | jq -r .args.command)" 2>&1); RC=$? ;;
      *) continue ;;
    esac
    printf '%s' "$OUT" | tail -c 64000 | jq -Rs --argjson rc "$RC" '{exit_code: $rc, output: .}' |
      curl -fsS -x "$PROXY" -X POST ${cfg.publicUrl}/v1/hosting/commands/$ID/result -H "$AUTH" -H 'Content-Type: application/json' --data-binary @- >/dev/null || true
  done
  sleep 3
done
AGENT
chmod 700 /usr/local/bin/mynt-agent-commands
cat >/etc/systemd/system/mynt-agent.service <<UNIT
[Unit]
After=wg-quick@wg0.service docker.service
[Service]
ExecStart=/usr/local/bin/mynt-agent
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/mynt-agent-commands.service <<UNIT
[Unit]
After=wg-quick@wg0.service docker.service
[Service]
ExecStart=/usr/local/bin/mynt-agent-commands
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now mynt-agent mynt-agent-commands
`;
}

export class HostingService {
  private constructor(
    private readonly db: Db,
    readonly provider: HostingProvider | DirectHostingProvider | null,
    readonly config: HostingConfig | null,
    private readonly sourceToken: (developerId: string, repository: string) => Promise<string | null>,
  ) {}

  static async open(
    db: Db,
    provider: HostingProvider | DirectHostingProvider | null,
    config: HostingConfig | null,
    sourceToken: (developerId: string, repository: string) => Promise<string | null> = async () => null,
  ) {
    await db.exec(TABLES);
    return new HostingService(db, provider, config, sourceToken);
  }

  get enabled() {
    return Boolean(this.provider && this.config);
  }

  private async one(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows[0] as Record<string, unknown> | undefined;
  }

  async tenantOf(developerId: string): Promise<Tenant | undefined> {
    const r = await this.one("SELECT * FROM financial_products.hosting_tenants WHERE developer_id = $1", [developerId]);
    return r && toTenant(r);
  }

  async tenants(): Promise<Tenant[]> {
    return (await this.db.query("SELECT * FROM financial_products.hosting_tenants ORDER BY created_at")).rows.map((r) => toTenant(r as Record<string, unknown>));
  }

  async hostedApps(tenantId?: string): Promise<HostedApp[]> {
    const rows = tenantId
      ? (await this.db.query("SELECT * FROM financial_products.hosted_apps WHERE tenant_id = $1 ORDER BY port", [tenantId])).rows
      : (await this.db.query("SELECT * FROM financial_products.hosted_apps ORDER BY tenant_id, port")).rows;
    return rows.map((r) => toHostedApp(r as Record<string, unknown>));
  }

  // A VM for this developer, booting with a one-time bootstrap token (valid an hour).
  async provision(developerId: string): Promise<Tenant> {
    if (!this.provider || !this.config) throw new Error("Hosting isn't configured on this deployment");
    const existing = await this.tenantOf(developerId);
    if (existing && existing.status !== "failed") return existing;
    if (existing) await this.db.query("DELETE FROM financial_products.hosting_tenants WHERE id = $1", [existing.id]);
    const id = randomUUID();
    if (isDirect(this.provider)) return this.provisionDirect(this.provider, id, developerId);
    const bootstrap = randomBytes(24).toString("base64url");
    await this.db.query(
      `INSERT INTO financial_products.hosting_tenants (id, developer_id, provider, status, bootstrap_hash, bootstrap_expires_at)
       VALUES ($1, $2, $3, 'provisioning', $4, now() + interval '1 hour')`,
      [id, developerId, this.provider.name, hash(bootstrap)],
    );
    try {
      const vm = await this.provider.createVm({
        name: `mynt-tenant-${id.slice(0, 8)}`,
        region: this.config.region,
        size: this.config.size,
        userData: tenantUserData(this.config, bootstrap),
        tags: ["mynt-tenant"],
      });
      await this.db.query("UPDATE financial_products.hosting_tenants SET vm_id = $2, updated_at = now() WHERE id = $1", [id, vm.id]);
    } catch (e) {
      await this.db.query("UPDATE financial_products.hosting_tenants SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, (e as Error).message.slice(0, 500)]);
    }
    return (await this.tenantOf(developerId))!;
  }

  private async provisionDirect(p: DirectHostingProvider, id: string, developerId: string): Promise<Tenant> {
    await this.db.query(
      "INSERT INTO financial_products.hosting_tenants (id, developer_id, provider, status) VALUES ($1, $2, $3, 'provisioning')",
      [id, developerId, p.name],
    );
    try {
      const vm = await p.createVm(`mynt-t-${id.slice(0, 8)}`);
      await this.db.query("UPDATE financial_products.hosting_tenants SET vm_id = $2, updated_at = now() WHERE id = $1", [id, vm.id]);
      const r = await p.run(vm.id, DIRECT_SETUP, { timeoutMs: 120_000 });
      if (r.exitCode !== 0) throw new Error(`setup failed: ${boxOutput(r.stderr || r.stdout).slice(-300)}`);
      await this.db.query("UPDATE financial_products.hosting_tenants SET status = 'running', updated_at = now() WHERE id = $1", [id]);
    } catch (e) {
      await this.db.query("UPDATE financial_products.hosting_tenants SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, (e as Error).message.slice(0, 500)]);
    }
    return (await this.tenantOf(developerId))!;
  }

  // Reads the app's compose file at the verified commit (if it has one) and checks it. GitHub is asked with the
  // developer's read-only token for that repository.
  githubFetch: typeof fetch = (...a) => fetch(...a);
  async planSource(developerId: string, repository: string, commitSha: string): Promise<{ composeFile: string | null; check: ComposeCheck | null }> {
    const token = await this.sourceToken(developerId, repository);
    for (const file of COMPOSE_FILES) {
      const res = await this.githubFetch(`https://api.github.com/repos/${repository}/contents/${file}?ref=${commitSha}`, {
        headers: { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`Couldn't read ${file} from ${repository}: GitHub said ${res.status}`);
      return { composeFile: file, check: checkCompose(await res.text()) };
    }
    return { composeFile: null, check: null };
  }

  // Where an app is served.
  appDomain(appId: string, expose = "web") {
    const base = this.config?.appsDomain ? `${appId.slice(0, 8)}.${this.config.appsDomain}` : isDirect(this.provider) ? `mynt-${appId.slice(0, 8)}.style.dev` : null;
    if (!base || expose === "web") return base;
    return this.config?.appsDomain ? `${appId.slice(0, 8)}-${expose}.${this.config.appsDomain}` : `mynt-${appId.slice(0, 8)}-${expose}.style.dev`;
  }

  // Runs a script on a direct VM as a detached job and waits for it, so a long build isn't cut off at the
  // provider's per-command limit. Secrets go in env; the script text holds none.
  jobPollMs = 5_000;
  private async runJob(p: DirectHostingProvider, vmId: string, script: string, env: Record<string, string>, timeoutMs = 30 * 60_000) {
    const job = `job-${randomUUID().slice(0, 8)}`;
    const dir = "$HOME/.mynt-jobs";
    const started = await p.run(
      vmId,
      `mkdir -p ${dir} && printf '%s' "$JOB_SCRIPT" > ${dir}/${job}.sh && (nohup bash ${dir}/${job}.sh > ${dir}/${job}.log 2>&1; echo $? > ${dir}/${job}.exit) >/dev/null 2>&1 & echo started`,
      { env: { ...env, JOB_SCRIPT: script }, timeoutMs: 30_000 },
    );
    if (started.exitCode !== 0) return { exitCode: started.exitCode, output: `${started.stdout}${started.stderr}` };
    const until = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, this.jobPollMs));
      const r = await p.run(vmId, `cat ${dir}/${job}.exit 2>/dev/null || echo running`, { timeoutMs: 30_000 });
      const state = r.stdout.trim();
      if (state !== "running" || Date.now() >= until) {
        const log = await p.run(vmId, `tail -c 8000 ${dir}/${job}.log 2>/dev/null; rm -f ${dir}/${job}.*`, { timeoutMs: 30_000 });
        return { exitCode: state === "running" ? null : Number(state), output: log.stdout };
      }
    }
  }

  // Direct VMs: egress is the union of the hosted apps' allowlists, nothing more.
  private async syncEgress(p: DirectHostingProvider, tenant: Tenant) {
    const rows = (await this.db.query("SELECT egress FROM financial_products.hosted_apps WHERE tenant_id = $1", [tenant.id])).rows as { egress: unknown }[];
    const hosts = new Set<string>();
    for (const r of rows) for (const h of (typeof r.egress === "string" ? JSON.parse(r.egress) : r.egress) ?? []) hosts.add(h);
    await p.setEgress(tenant.vm_id!, [...hosts].sort());
  }

  // Builds and runs the verified commit on the VM; secrets travel as the job's environment, never its text.
  private async deployDirect(p: DirectHostingProvider, tenant: Tenant, hosted: HostedApp, appKey: string, plan: { composeFile: string | null; check: ComposeCheck | null }) {
    const fail = (message: string) =>
      this.db.query("UPDATE financial_products.hosted_apps SET status = 'stopped', error = $2, updated_at = now() WHERE app_id = $1", [hosted.app_id, message.slice(0, 1000)]);
    try {
      await this.syncEgress(p, tenant);
      const token = await this.sourceToken(tenant.developer_id, hosted.repository);
      const services = hosted.services ?? [];
      const origin = this.config?.publicUrl ?? "";
      const r = await this.runJob(p, tenant.vm_id!, DIRECT_DEPLOY, {
        NAME: containerName(hosted.app_id),
        SHA: hosted.commit_sha,
        PORT: String(hosted.port),
        SOURCE_URL: `https://api.github.com/repos/${hosted.repository}/tarball/${hosted.commit_sha}`,
        SOURCE_TOKEN: token ?? "",
        COMPOSE_FILE_NAME: plan.composeFile ?? "",
        COMPOSE_OVERRIDE: plan.check ? composeOverride(plan.check, Object.fromEntries(services.map((x) => [x.expose, x.port]))) : "",
        MYNT_API_KEY: appKey,
        MYNT_BASE_URL: `${origin}/v1`,
        MYNT_API_BASE: `${origin}/v1`,
        MYNT_API_ORIGIN: origin,
      });
      if (r.exitCode !== 0) return void (await fail(boxOutput(r.output, [appKey, token ?? ""]).slice(-1000) || "The build was killed by its time limit"));
      for (const x of services.length ? services : [{ port: hosted.port, domain: this.appDomain(hosted.app_id) }]) if (x.domain) await p.setRoute(tenant.vm_id!, x.domain, x.port);
      await this.db.query("UPDATE financial_products.hosted_apps SET status = 'running', error = NULL, updated_at = now() WHERE app_id = $1 AND commit_sha = $2", [hosted.app_id, hosted.commit_sha]);
    } catch (e) {
      await fail((e as Error).message);
    }
  }

  // A login for the developer on their VM (their Linux user, in the docker group, no sudo); the previous one is revoked.
  async vmAccess(tenant: Tenant, hours = 8) {
    if (!isDirect(this.provider)) throw new Error("Direct VM access needs a direct hosting provider");
    if (tenant.status !== "running" || !tenant.vm_id) throw new Error(`Your VM is ${tenant.status}`);
    const prev = (await this.one("SELECT access_identity FROM financial_products.hosting_tenants WHERE id = $1", [tenant.id]))?.access_identity as string | null;
    if (prev) await this.provider.revokeAccess(prev).catch(() => undefined);
    const grant = await this.provider.grantAccess(tenant.vm_id, "developer", new Date(Date.now() + hours * 3600e3));
    await this.db.query("UPDATE financial_products.hosting_tenants SET access_identity = $2, updated_at = now() WHERE id = $1", [tenant.id, grant.identity]);
    return { ssh: grant.ssh, expires_at: grant.expires_at };
  }

  // A booting VM registers its WireGuard key with its one-time token; it gets its tunnel address and agent token.
  async bootstrap(token: string, wgPublicKey: string) {
    if (!this.provider || !this.config) throw new Error("Hosting isn't configured on this deployment");
    if (isDirect(this.provider)) return null;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(wgPublicKey)) throw new Error("wg_public_key must be a WireGuard public key");
    const r = await this.one(
      "SELECT * FROM financial_products.hosting_tenants WHERE bootstrap_hash = $1 AND bootstrap_expires_at > now() AND status = 'provisioning'",
      [hash(token)],
    );
    if (!r) return null;
    const used = (await this.db.query("SELECT tunnel_index FROM financial_products.hosting_tenants WHERE tunnel_index IS NOT NULL ORDER BY tunnel_index")).rows.map((x) => Number((x as { tunnel_index: number }).tunnel_index));
    let index = 0;
    while (used.includes(index)) index++;
    const agent = randomBytes(32).toString("base64url");
    await this.db.query(
      `UPDATE financial_products.hosting_tenants SET status = 'running', tunnel_index = $2, wg_public_key = $3, agent_hash = $4,
         bootstrap_hash = NULL, bootstrap_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [r.id, index, wgPublicKey, hash(agent)],
    );
    if (r.vm_id) await this.provider.lockDown(r.vm_id as string, this.config.gatewayIp, Number(this.config.gatewayEndpoint.split(":")[1] ?? 51820));
    return { tunnel_ip: tunnelIp(index)!, gateway_tunnel_ip: GATEWAY_TUNNEL_IP, agent_token: agent };
  }

  async tenantByAgent(token: string): Promise<Tenant | undefined> {
    const r = await this.one("SELECT * FROM financial_products.hosting_tenants WHERE agent_hash = $1", [hash(token)]);
    return r && toTenant(r);
  }

  // Runs an app's verified commit on its developer's VM, with a dedicated app key kept sealed.
  async deploy(
    tenant: Tenant,
    app: { id: string },
    build: { id: string; repository: string; commit_sha: string },
    appKey: string,
    sandbox: boolean,
    egress: string[] = [],
    plan: { composeFile: string | null; check: ComposeCheck | null } = { composeFile: null, check: null },
  ): Promise<HostedApp> {
    if (plan.check?.errors.length) throw new Error(`The compose file isn't accepted: ${plan.check.errors.join("; ")}`);
    if (plan.composeFile && !isDirect(this.provider)) throw new Error("Compose apps need direct hosting (Freestyle)");
    const ports = (await this.hostedApps(tenant.id)).filter((h) => h.app_id !== app.id).flatMap((h) => [h.port, ...(h.services ?? []).map((x) => x.port)]);
    const free = () => {
      let n = 9000;
      while (ports.includes(n)) n++;
      ports.push(n);
      return n;
    };
    const services: HostedService[] = (plan.check?.exposed ?? []).map((e) => ({ service: e.service, expose: e.expose, port: free(), domain: this.appDomain(app.id, e.expose) }));
    const port = services[0]?.port ?? free();
    const r = await this.one(
      `INSERT INTO financial_products.hosted_apps (app_id, tenant_id, build_id, repository, commit_sha, port, app_key_sealed, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'deploying')
       ON CONFLICT (app_id) DO UPDATE SET build_id = EXCLUDED.build_id, repository = EXCLUDED.repository, commit_sha = EXCLUDED.commit_sha,
         app_key_sealed = EXCLUDED.app_key_sealed, status = 'deploying', updated_at = now()
       RETURNING *`,
      [app.id, tenant.id, build.id, build.repository, build.commit_sha, port, seal(appKey, sandbox) + (sandbox ? ":sandbox" : ":live")],
    );
    void r;
    const hosted = toHostedApp(
      (await this.one(
        "UPDATE financial_products.hosted_apps SET egress = $2, error = NULL, compose_file = $3, services = $4 WHERE app_id = $1 RETURNING *",
        [app.id, JSON.stringify(egress), plan.composeFile, services.length ? JSON.stringify(services) : null],
      ))!,
    );
    if (isDirect(this.provider)) this.pending = this.deployDirect(this.provider, tenant, hosted, appKey, plan);
    return hosted;
  }

  async undeploy(appId: string): Promise<boolean> {
    const r = (await this.db.query("DELETE FROM financial_products.hosted_apps WHERE app_id = $1 RETURNING tenant_id, services", [appId])).rows[0] as
      | { tenant_id: string; services: unknown }
      | undefined;
    if (!r) return false;
    const services = ((typeof r.services === "string" ? JSON.parse(r.services) : r.services) ?? []) as HostedService[];
    const p = this.provider;
    if (isDirect(p)) {
      const tenant = (await this.tenants()).find((t) => t.id === r.tenant_id);
      if (tenant?.vm_id) {
        const name = containerName(appId);
        await p.run(tenant.vm_id, `docker compose -p ${name} down --remove-orphans >/dev/null 2>&1; docker rm -f ${name} >/dev/null 2>&1 || true`).catch(() => undefined);
        for (const domain of services.length ? services.map((x) => x.domain) : [this.appDomain(appId)]) if (domain) await p.removeRoute(domain).catch(() => undefined);
        await this.syncEgress(p, tenant).catch(() => undefined);
      }
    }
    return true;
  }

  // The background deploy of a direct VM, for tests and the CLI to await.
  pending: Promise<unknown> = Promise.resolve();

  // The kill switch: off the gateway at once (peers, routes, allowlist) and powered off.
  async suspend(tenantId: string): Promise<Tenant | undefined> {
    const r = await this.one("UPDATE financial_products.hosting_tenants SET status = 'suspended', updated_at = now() WHERE id = $1 RETURNING *", [tenantId]);
    if (r?.vm_id && this.provider) await (isDirect(this.provider) ? this.provider.pause(r.vm_id as string) : this.provider.powerOff(r.vm_id as string)).catch(() => undefined);
    return r && toTenant(r);
  }

  async resume(tenantId: string): Promise<Tenant | undefined> {
    const r = await this.one("UPDATE financial_products.hosting_tenants SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'suspended' RETURNING *", [tenantId]);
    if (r?.vm_id && this.provider) await (isDirect(this.provider) ? this.provider.start(r.vm_id as string) : this.provider.powerOn(r.vm_id as string)).catch(() => undefined);
    return r && toTenant(r);
  }

  // What a VM's agent runs: each app at its verified commit, with a short-lived token to fetch it.
  async policy(tenant: Tenant, egressFor: (appId: string) => Promise<string[]>) {
    if (tenant.status !== "running") return { apps: [], status: tenant.status };
    const out = [];
    for (const h of await this.hostedApps(tenant.id)) {
      const row = await this.one("SELECT app_key_sealed FROM financial_products.hosted_apps WHERE app_id = $1", [h.app_id]);
      const stored = String(row?.app_key_sealed ?? "");
      const sandbox = stored.endsWith(":sandbox");
      const appKey = open(stored.replace(/:(sandbox|live)$/, ""), sandbox);
      out.push({
        name: containerName(h.app_id),
        app_id: h.app_id,
        commit_sha: h.commit_sha,
        source_url: `https://api.github.com/repos/${h.repository}/tarball/${h.commit_sha}`,
        source_token: await this.sourceToken(tenant.developer_id, h.repository),
        port: h.port,
        tunnel_ip: tenant.tunnel_ip,
        app_key: appKey,
        mynt_base_url: `${this.config?.publicUrl ?? ""}/v1`,
        egress: await egressFor(h.app_id),
      });
    }
    return { apps: out, status: tenant.status };
  }

  // A command for the developer's VM, against one of their app containers.
  async queueCommand(tenant: Tenant, appId: string, kind: HostingCommandKind, args: Record<string, unknown>, requestedBy: string): Promise<HostingCommand> {
    if (tenant.status !== "running") throw new Error(`Your VM is ${tenant.status}`);
    if (!(await this.hostedApps(tenant.id)).some((h) => h.app_id === appId)) throw new Error("That app isn't hosted on your VM");
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO financial_products.hosting_commands (id, tenant_id, app_id, kind, args, status, requested_by) VALUES ($1, $2, $3, $4, $5, 'queued', $6)",
      [id, tenant.id, appId, kind, JSON.stringify(args), requestedBy],
    );
    if (isDirect(this.provider) && tenant.vm_id) {
      await this.db.query("UPDATE financial_products.hosting_commands SET status = 'running' WHERE id = $1", [id]);
      const timeout = Number(args.timeout_seconds ?? 60);
      const r = await this.provider
        .run(tenant.vm_id, directCommand(kind, containerName(appId), args), {
          timeoutMs: (timeout + 5) * 1000,
          env: { ...(kind === "exec" ? { CMD: String(args.command) } : {}), SERVICE: String(args.service ?? "") },
        })
        .catch((e: Error) => ({ exitCode: null, stdout: "", stderr: e.message }));
      await this.finishCommand(tenant, id, r.exitCode, `${r.stdout}${r.stderr}`);
    }
    return (await this.command(id))!;
  }

  async command(id: string): Promise<HostingCommand | undefined> {
    const r = await this.one("SELECT * FROM financial_products.hosting_commands WHERE id = $1", [id]);
    return r && toCommand(r);
  }

  // The VM's agent claims what's queued for it; anything it hasn't picked up in two minutes expires.
  async claimCommands(tenant: Tenant) {
    await this.db.query(
      "UPDATE financial_products.hosting_commands SET status = 'expired', finished_at = now() WHERE tenant_id = $1 AND status IN ('queued', 'running') AND created_at < now() - interval '2 minutes'",
      [tenant.id],
    );
    const rows = (
      await this.db.query("UPDATE financial_products.hosting_commands SET status = 'running' WHERE tenant_id = $1 AND status = 'queued' RETURNING *", [tenant.id])
    ).rows.map((r) => toCommand(r as Record<string, unknown>));
    return rows.map((c) => ({ id: c.id, kind: c.kind, container: containerName(c.app_id), args: c.args }));
  }

  async finishCommand(tenant: Tenant, id: string, exitCode: number | null, output: string): Promise<boolean> {
    const r = await this.db.query(
      "UPDATE financial_products.hosting_commands SET status = 'done', exit_code = $3, output = $4, finished_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'running' RETURNING id",
      [id, tenant.id, exitCode, boxOutput(output)],
    );
    return r.rows.length > 0;
  }

  // Waits for the VM to report (it checks every few seconds).
  async waitForCommand(id: string, timeoutMs = 30_000, pollMs = 300): Promise<HostingCommand> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const c = (await this.command(id))!;
      if (c.status === "done" || c.status === "expired" || Date.now() >= until) return c;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // The gateway's WireGuard peers: running tenants only.
  async wireguardPeers(): Promise<string> {
    return (await this.tenants())
      .filter((t) => t.status === "running" && t.wg_public_key && t.tunnel_ip)
      .map((t) => `[Peer]\n# tenant ${t.id}\nPublicKey = ${t.wg_public_key}\nAllowedIPs = ${t.tunnel_ip}/32\n`)
      .join("\n");
  }

  // Where the edge sends each hosted app's traffic: <app>.<appsDomain> to the app on its tenant's tunnel address.
  async routes(): Promise<{ host: string; upstream: string }[]> {
    if (!this.config?.appsDomain || isDirect(this.provider)) return [];
    const running = new Map((await this.tenants()).filter((t) => t.status === "running").map((t) => [t.id, t]));
    return (await this.hostedApps())
      .filter((h) => running.has(h.tenant_id))
      .map((h) => ({ host: `${h.app_id.slice(0, 8)}.${this.config!.appsDomain}`, upstream: `${running.get(h.tenant_id)!.tunnel_ip}:${h.port}` }));
  }
}
