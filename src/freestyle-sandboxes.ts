// Agent sandboxes on Freestyle: the same BoatClient the builds, reviews, the product desk and the connector use,
// backed by a Freestyle VM per sandbox. Everything runs as a `user` account (home /home/user, the paths agents
// expect), with the sandbox's env loaded from a 0600 file. Previews and downloads are served at unguessable
// style.dev names, so a URL is its own credential, like boat's token-gated links.
import { randomBytes } from "node:crypto";
import { HttpBoatClient, type BoatClient, type SandboxState } from "./boat.js";
import { shellQuote } from "./boxes.js";
import { FreestyleProvider } from "./freestyle.js";

const USER = "user";
const NODE_VERSION = "22.11.0";
const PROCS = "/home/user/.mynt-procs";
const CHUNK = 512 * 1024;

// First boot: the agents' account (docker, no sudo), Node for the runner, and the sandbox env.
const SETUP = `set -e
id ${USER} >/dev/null 2>&1 || sudo -n useradd --create-home --home-dir /home/${USER} --shell /bin/bash ${USER}
sudo -n usermod -aG docker ${USER} 2>/dev/null || true
if ! command -v node >/dev/null || ! node --version | grep -q '^v2[2-9]'; then
  curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz | sudo -n tar -xJ -C /usr/local --strip-components=1
fi
printf '%s' "$MYNT_ENV" | base64 -d | sudo -n tee /home/${USER}/.mynt-env >/dev/null
sudo -n chown ${USER}:${USER} /home/${USER}/.mynt-env && sudo -n chmod 600 /home/${USER}/.mynt-env
sudo -n -u ${USER} mkdir -p ${PROCS}
node --version`;

// Every command: the sandbox env, from the home directory, as the agents' account.
const wrap = (command: string) => `set -a; [ -f ~/.mynt-env ] && . ~/.mynt-env; set +a; cd ~; ${command}`;

export const envFile = (env: Record<string, string>) =>
  Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}\n`)
    .join("");

const STATES: Record<string, SandboxState> = {
  starting: "provisioning",
  running: "ready",
  pausing: "archiving",
  paused: "archived",
  stopping: "archiving",
  stopped: "archived",
  failed: "error",
  deleted: "cancelled",
};

export class FreestyleSandboxes implements BoatClient {
  constructor(
    private readonly fs: FreestyleProvider,
    private readonly opts: { usdPerHour?: number; setupTimeoutMs?: number } = {},
  ) {}

  private run(id: string, command: string, opts: { env?: Record<string, string>; timeoutMs?: number; stdin?: string } = {}) {
    return this.fs.run(id, wrap(command), { ...opts, linuxUser: USER });
  }

  async createSandbox(opts: { name: string; type?: string; ttlSeconds?: number; labels?: Record<string, string>; env?: Record<string, string> }) {
    const slug = opts.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 63).replace(/-$/, "");
    // Agents need the open Internet (packages, GitHub, Mynt's API and agent proxy), as on boat.
    const vm = await this.fs.call<{ id: string }>("POST", "/vms", {
      slug,
      displayName: opts.name,
      ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
      metadata: Object.fromEntries(Object.entries(opts.labels ?? {}).map(([k, v]) => [k.slice(0, 63), v.slice(0, 63)])),
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    });
    const r = await this.fs.run(vm.id, SETUP, { env: { MYNT_ENV: Buffer.from(envFile(opts.env ?? {})).toString("base64") }, timeoutMs: this.opts.setupTimeoutMs ?? 240_000 });
    if (r.exitCode !== 0) {
      await this.fs.deleteVm(vm.id).catch(() => undefined);
      throw new Error(`Sandbox setup failed: ${(r.stderr || r.stdout).slice(-300)}`);
    }
    return { id: vm.id, state: "ready" as SandboxState };
  }

  async getSandbox(id: string) {
    const vm = await this.fs.call<{ id: string; state: string }>("GET", `/vms/${encodeURIComponent(id)}`);
    return { id: vm.id, state: STATES[vm.state] ?? ("provisioning" as SandboxState), error: null };
  }

  async writeFile(id: string, path: string, content: string) {
    const data = Buffer.from(content);
    for (let i = 0; i === 0 || i < data.length; i += CHUNK) {
      // Freestyle takes stdin base64-encoded and hands the process the raw bytes.
      const r = await this.run(id, `mkdir -p "$(dirname "$MYNT_PATH")" && cat ${i === 0 ? ">" : ">>"} "$MYNT_PATH"`, {
        env: { MYNT_PATH: path },
        stdin: data.subarray(i, i + CHUNK).toString("base64"),
      });
      if (r.exitCode !== 0) throw new Error(`Couldn't write ${path}: ${r.stderr.slice(-200)}`);
    }
  }

  async readFile(id: string, path: string) {
    const r = await this.run(id, `if [ -f "$MYNT_PATH" ]; then base64 -w0 "$MYNT_PATH"; else echo MISSING >&2; exit 3; fi`, { env: { MYNT_PATH: path } });
    if (r.exitCode === 3) return null;
    if (r.exitCode !== 0) throw new Error(`Couldn't read ${path}: ${r.stderr.slice(-200)}`);
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  }

  // Serves a port at an unguessable name. Services that bind only localhost (previews, the editor) are reached
  // through a small forwarder on the VM's own address.
  async host(id: string, port: number) {
    const outer = 20000 + (port % 10000);
    const fwd = `require("net").createServer((c)=>{const u=require("net").connect(${port},"127.0.0.1");c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(${outer},"0.0.0.0")`;
    const pid = `${PROCS}/fwd-${outer}.pid`;
    await this.run(id, `mkdir -p ${PROCS}; if ! { [ -f ${pid} ] && kill -0 "$(cat ${pid})" 2>/dev/null; }; then nohup node -e ${shellQuote(fwd)} >/dev/null 2>&1 & echo $! > ${pid}; fi; echo ok`);
    const domain = `mynt-pv-${randomBytes(12).toString("hex")}.style.dev`;
    await this.fs.setRoute(id, domain, outer);
    return { url: `https://${domain}` };
  }

  // Machine time, at the configured hourly rate; the agent's model spend is tracked by Mynt's runner.
  async costDollars(id: string) {
    return ((await this.fs.usage(id)).seconds / 3600) * (this.opts.usdPerHour ?? 0.2);
  }

  // Stopping a sandbox ends it: the VM and everything routed to it go.
  async stop(id: string) {
    await this.fs.deleteVm(id);
  }

  async exec(id: string, command: string, opts: { timeoutSeconds?: number; detached?: boolean } = {}) {
    if (opts.detached) {
      // Mynt names the process: its pid and, once it ends, its exit code are kept in files under that number.
      const processId = randomBytes(4).readUInt32BE(0) % 1_000_000_000;
      const r = await this.run(id, `mkdir -p ${PROCS}; ( bash -c "$MYNT_CMD"; echo $? > ${PROCS}/${processId}.exit ) >/dev/null 2>&1 & echo $! > ${PROCS}/${processId}.pid; echo started`, {
        env: { MYNT_CMD: command },
      });
      if (r.exitCode !== 0) throw new Error(`Couldn't start the command: ${r.stderr.slice(-200)}`);
      return { processId, exitCode: null, stdout: "", stderr: "" };
    }
    const r = await this.run(id, `bash -c "$MYNT_CMD"`, { env: { MYNT_CMD: command }, timeoutMs: Math.min((opts.timeoutSeconds ?? 600) * 1000, 300_000) });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  async commandStatus(id: string, processId: number) {
    const f = `${PROCS}/${Math.floor(processId)}`;
    const r = await this.run(id, `if [ -f ${f}.exit ]; then echo "exit $(cat ${f}.exit)"; elif [ -f ${f}.pid ] && kill -0 "$(cat ${f}.pid)" 2>/dev/null; then echo running; else echo gone; fi`);
    const out = r.stdout.trim();
    if (out === "running") return { running: true, exitCode: null };
    return { running: false, exitCode: out.startsWith("exit ") ? Number(out.slice(5)) : null };
  }

  // A one-file download: a small server on the VM answers only at an unguessable path, for ttlSeconds.
  async downloadUrl(id: string, path: string, ttlSeconds = 3600) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("ttlSeconds must be an integer between 1 and 3600.");
    const token = randomBytes(18).toString("hex");
    const port = 30000 + randomBytes(2).readUInt16BE(0) % 10000;
    const server = `const fs=require("fs");require("http").createServer((q,s)=>{if(q.url!=="/${token}"){s.statusCode=404;return s.end()}s.setHeader("content-type","application/octet-stream");fs.createReadStream(process.env.MYNT_PATH).on("error",()=>{s.statusCode=404;s.end()}).pipe(s)}).listen(${port},"0.0.0.0")`;
    const r = await this.run(id, `(MYNT_PATH=${shellQuote(path)} nohup timeout ${ttlSeconds} node -e ${shellQuote(server)} >/dev/null 2>&1 &); echo ok`);
    if (r.exitCode !== 0) throw new Error(`Couldn't serve ${path}: ${r.stderr.slice(-200)}`);
    const domain = `mynt-dl-${randomBytes(12).toString("hex")}.style.dev`;
    await this.fs.setRoute(id, domain, port);
    return `https://${domain}/${token}`;
  }
}

// Agent sandboxes (builds, the product desk, governance review, the connector): boat.dev, or Freestyle VMs with
// SANDBOX_PROVIDER=freestyle (also the default when only a Freestyle key is configured).
export function sandboxesFromEnv(env = process.env): BoatClient | null {
  const freestyle = env.FREESTYLE_API_KEY && (env.SANDBOX_PROVIDER === "freestyle" || (!env.SANDBOX_PROVIDER && !env.BOAT_API_KEY));
  if (freestyle) return new FreestyleSandboxes(new FreestyleProvider(env.FREESTYLE_API_KEY!), { usdPerHour: Number(env.FREESTYLE_USD_PER_HOUR ?? 0.2) });
  return env.BOAT_API_KEY && env.SANDBOX_PROVIDER !== "freestyle" ? new HttpBoatClient(env.BOAT_API_KEY) : null;
}

