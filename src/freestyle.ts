import { resolve4 } from "node:dns/promises";

// Freestyle (freestyle.sh) as a direct hosting provider: Mynt drives each developer's VM through Freestyle's API
// instead of the VM pulling a policy over a tunnel. A VM boots with an empty firewall (nothing in, nothing out);
// its egress is per-domain TLS rules, its apps are reached through public TLS routes to a port, and the developer
// gets SSH with a scoped token for one Linux user.

export interface DirectRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface DirectHostingProvider {
  readonly name: string;
  readonly direct: true;
  createVm(slug: string): Promise<{ id: string }>;
  run(vmId: string, command: string, opts?: { env?: Record<string, string>; timeoutMs?: number; linuxUser?: string; stdin?: string }): Promise<DirectRun>;
  // Replaces the VM's egress allowlist with exactly these hosts.
  setEgress(vmId: string, hosts: string[]): Promise<void>;
  // Serves https://<domain> from a port on the VM (replacing any route for that domain).
  setRoute(vmId: string, domain: string, port: number): Promise<void>;
  removeRoute(domain: string): Promise<void>;
  pause(vmId: string): Promise<void>;
  start(vmId: string): Promise<void>;
  deleteVm(vmId: string): Promise<void>;
  // An SSH login for one Linux user on the VM, valid until expiresAt.
  grantAccess(vmId: string, linuxUser: string, expiresAt: Date): Promise<{ ssh: string; expires_at: string; identity: string }>;
  // Machine time so far, never under-counted.
  usage(vmId: string): Promise<{ seconds: number }>;
  revokeAccess(identity: string): Promise<void>;
}

export const isDirect = (p: unknown): p is DirectHostingProvider => !!p && (p as { direct?: unknown }).direct === true;

export const FREESTYLE_SSH_HOST = "beta-ssh.freestyle.sh";
// Hosts Freestyle's edge resets after the TLS hello (the npm registries, as of 2026-10): these are allowed at the
// network layer instead, by their own IPv4 addresses, resolved at each sync.
export const NETWORK_EGRESS_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

export class FreestyleProvider implements DirectHostingProvider {
  readonly name = "freestyle";
  readonly direct = true as const;
  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: typeof fetch; base?: string; resolve4?: (host: string) => Promise<string[]> } = {},
  ) {}

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.base ?? "https://api.freestyle.sh/v5"}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Freestyle ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createVm(slug: string) {
    const vm = await this.call<{ id: string }>("POST", "/vms", { slug, displayName: slug, firewall: { rules: [] }, automaticRestart: true });
    return { id: vm.id };
  }

  async run(vmId: string, command: string, opts: { env?: Record<string, string>; timeoutMs?: number; linuxUser?: string; stdin?: string } = {}) {
    const r = await this.call<{ stdout?: string; stderr?: string; statusCode: number | null }>("POST", `/vms/${encodeURIComponent(vmId)}/exec-await`, {
      command,
      timeoutMs: Math.min(opts.timeoutMs ?? 30_000, 300_000),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.linuxUser ? { linuxUser: opts.linuxUser } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    return { exitCode: r.statusCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  // Rules are told apart by shape: egress goes from a VM to the public Internet, a route from the public to a VM.
  private async rules(match: (r: TlsRule) => boolean) {
    const { rules } = await this.call<{ rules: TlsRule[] }>("GET", "/tls");
    return rules.filter(match);
  }

  async setEgress(vmId: string, hosts: string[]) {
    await this.setNetworkEgress(vmId, hosts.filter((h) => NETWORK_EGRESS_HOSTS.has(h)));
    const current = await this.rules((r) => r.source?.vmId === vmId && r.destination?.public === true);
    const want = new Set(hosts.filter((h) => !NETWORK_EGRESS_HOSTS.has(h)));
    // A plain outbound rule passes TLS straight through: the VM's TLS runs end to end to the host, so nothing in
    // between sees its requests or the app key in them.
    const keep = current.filter((r) => want.has(r.domain));
    for (const r of current) if (!keep.includes(r)) await this.call("DELETE", `/tls/${r.id}`);
    const have = new Set(keep.map((r) => r.domain));
    for (const domain of want)
      if (!have.has(domain)) await this.call("POST", "/tls", { action: "allow", domain, source: { vmId }, destination: { public: true } });
  }

  private async setNetworkEgress(vmId: string, hosts: string[]) {
    const want = new Set<string>();
    for (const h of hosts) for (const ip of await (this.opts.resolve4 ?? resolve4)(h).catch(() => [] as string[])) want.add(`${ip}/32`);
    const { rules } = await this.call<{ rules: FirewallRule[] }>("GET", "/firewall/rules");
    const current = rules.filter((r) => r.source?.vmId === vmId && r.destination?.cidr);
    for (const r of current) if (!want.has(r.destination!.cidr!)) await this.call("DELETE", `/firewall/rules/${r.id}`);
    const have = new Set(current.map((r) => r.destination!.cidr!));
    for (const cidr of want) if (!have.has(cidr)) await this.call("POST", "/firewall/rules", { action: "allow", source: { vmId }, destination: { cidr } });
  }

  async setRoute(vmId: string, domain: string, port: number) {
    await this.removeRoute(domain);
    // Inbound is terminated at the edge, which holds the certificate for the app's name.
    await this.call("POST", "/tls", { action: "allow", domain, protocol: "http", source: { public: true }, destination: { vmId, port } });
  }

  async removeRoute(domain: string) {
    for (const r of await this.rules((x) => x.domain === domain && x.source?.public === true && !!x.destination?.vmId)) await this.call("DELETE", `/tls/${r.id}`);
  }

  async pause(vmId: string) {
    await this.call("POST", `/vms/${encodeURIComponent(vmId)}/pause`, {});
  }

  async start(vmId: string) {
    await this.call("POST", `/vms/${encodeURIComponent(vmId)}/start`, {});
  }

  async deleteVm(vmId: string) {
    await this.call("DELETE", `/vms/${encodeURIComponent(vmId)}`);
  }

  // One identity per grant: deleting it later revokes the token and the grant together.
  async grantAccess(vmId: string, linuxUser: string, expiresAt: Date) {
    const { id } = await this.call<{ id: string }>("POST", "/identities", {});
    await this.call("POST", `/identities/${id}/permissions/vm`, { vmId, allowedLinuxUsers: [linuxUser] });
    const t = await this.call<{ token: string; expiresAt: string | null }>("POST", `/identities/${id}/tokens`, { expiresAt: expiresAt.toISOString() });
    return { ssh: `ssh ${vmId}+${linuxUser}:${t.token}@${FREESTYLE_SSH_HOST}`, expires_at: t.expiresAt ?? expiresAt.toISOString(), identity: id };
  }

  // Freestyle's own run-seconds can lag (it reads 0 on a VM that has been running), so the larger of that and the
  // time since the VM was created is what spend caps see.
  async usage(vmId: string) {
    const vm = await this.call<{ totalRunSeconds?: number | null; createdAt?: string }>("GET", `/vms/${encodeURIComponent(vmId)}`).catch(() => ({}) as { totalRunSeconds?: number; createdAt?: string });
    const since = vm.createdAt ? Math.max(0, (Date.now() - Date.parse(vm.createdAt)) / 1000) : 0;
    return { seconds: Math.max(vm.totalRunSeconds ?? 0, since) };
  }

  async revokeAccess(identity: string) {
    await this.call("DELETE", `/identities/${encodeURIComponent(identity)}`);
  }
}

interface FirewallRule {
  id: string;
  source?: { vmId?: string | null };
  destination?: { cidr?: string | null };
}

interface TlsRule {
  id: string;
  domain: string;
  protocol?: string;
  source?: { vmId?: string | null; public?: boolean | null };
  destination?: { vmId?: string | null; port?: number | null; public?: boolean | null };
}
