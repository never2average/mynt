// A small client for the boat.dev sandbox API (https://docs.boat.dev/api/v1). Builds use boat only for
// machines: Mynt runs the coding agent itself (see agent-runner.ts). This is the only part of Mynt that
// talks to boat, behind an interface so tests can provide a stand-in.

export type SandboxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error"
  | "cancelled";

export interface BoatClient {
  createSandbox(opts: { name: string; type?: string; ttlSeconds?: number; labels?: Record<string, string>; env?: Record<string, string> }): Promise<{ id: string; state: SandboxState }>;
  getSandbox(id: string): Promise<{ id: string; state: SandboxState; error?: string | null }>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  // Many files at once, when the host can do it faster than one by one.
  writeFiles?(id: string, files: Record<string, string>): Promise<void>;
  readFile(id: string, path: string): Promise<string | null>;
  host(id: string, port: number): Promise<{ url: string }>;
  costDollars(id: string): Promise<number>;
  stop(id: string): Promise<void>;
  // Runs a shell command; detached commands return a processId to poll.
  exec(id: string, command: string, opts?: { timeoutSeconds?: number; detached?: boolean }): Promise<{ processId?: number; exitCode: number | null; stdout: string; stderr: string }>;
  commandStatus(id: string, processId: number): Promise<{ running: boolean; exitCode: number | null }>;
  downloadUrl(id: string, path: string, ttlSeconds?: number): Promise<string>;
}

export class BoatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class HttpBoatClient implements BoatClient {
  constructor(
    private readonly apiKey: string,
    private readonly base = "https://boat.dev/api/v1",
  ) {}

  private async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "User-Agent": "mynt", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok || data.ok === false) throw new BoatApiError(res.status, data.code, data.message ?? `boat API ${res.status}`);
    return data as T;
  }

  async createSandbox(opts: Parameters<BoatClient["createSandbox"]>[0]) {
    const r = await this.call<{ sandbox: { id: string; state: SandboxState } }>(
      "POST",
      "/sandboxes",
      { name: opts.name, type: opts.type ?? "default", ttlSeconds: opts.ttlSeconds, labels: opts.labels, env: opts.env },
      { "Idempotency-Key": `mynt-${opts.name}` },
    );
    return { id: r.sandbox.id, state: r.sandbox.state };
  }

  async getSandbox(id: string) {
    const r = await this.call<{ sandbox: { id: string; state: SandboxState; error?: string | null } }>("GET", `/sandboxes/${encodeURIComponent(id)}`);
    return r.sandbox;
  }

  async writeFile(id: string, path: string, content: string) {
    await this.call("PUT", `/sandboxes/${encodeURIComponent(id)}/files`, { path, content, encoding: "utf8" });
  }

  async readFile(id: string, path: string) {
    try {
      const r = await this.call<{ content?: string }>("GET", `/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}&encoding=utf8`);
      return r.content ?? null;
    } catch (e) {
      // A file that isn't there yet: boat answers 404, or another status with an ENOENT message.
      if (e instanceof BoatApiError && (e.status === 404 || /ENOENT|no such file/i.test(e.message))) return null;
      throw e;
    }
  }

  // Token-gated by default: the URL carries its own access token.
  async host(id: string, port: number) {
    const r = await this.call<{ url: string }>("POST", `/sandboxes/${encodeURIComponent(id)}/host`, { port, public: false });
    return { url: r.url };
  }

  // Machine time; the agent's model spend is tracked by Mynt's runner.
  async costDollars(id: string) {
    const vm = await this.call<{ dollars?: number }>("GET", `/sandboxes/${encodeURIComponent(id)}/usage`);
    return vm.dollars ?? 0;
  }

  async stop(id: string) {
    await this.call("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, {});
  }

  async exec(id: string, command: string, opts: { timeoutSeconds?: number; detached?: boolean } = {}) {
    const r = await this.call<{ processId?: number; exitCode: number | null; stdout?: string; stderr?: string }>(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/commands`,
      { command, timeoutSeconds: opts.timeoutSeconds ?? 600, detached: opts.detached ?? false },
    );
    return { processId: r.processId, exitCode: r.exitCode ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  async commandStatus(id: string, processId: number) {
    const r = await this.call<{ running: boolean; exitCode: number | null }>("GET", `/sandboxes/${encodeURIComponent(id)}/commands/${processId}`);
    return { running: r.running, exitCode: r.exitCode ?? null };
  }

  async downloadUrl(id: string, path: string, ttlSeconds = 3600) {
    const r = await this.call<{ url: string }>("POST", `/sandboxes/${encodeURIComponent(id)}/files/download-url`, { path, ttlSeconds });
    return r.url;
  }
}
