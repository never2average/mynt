// Docker Compose apps on a developer's VM: what Mynt accepts in a compose file, which services it serves, and the
// override it adds so every service runs hardened.
import { load } from "js-yaml";

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;
const EXPOSE_NAME = /^[a-z][a-z0-9-]{0,19}$/;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1):/;

export interface ExposedService {
  service: string;
  expose: string; // the name it's served under ("web" is the app's own address)
  port: number; // the port it listens on inside its container
}

export interface ComposeCheck {
  errors: string[];
  services: string[]; // started by default (no profile)
  exposed: ExposedService[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function labels(svc: Obj): Record<string, string> {
  const l = svc.labels;
  if (Array.isArray(l)) return Object.fromEntries(l.map(String).map((s) => [s.split("=")[0], s.slice(s.indexOf("=") + 1)]));
  return isObj(l) ? Object.fromEntries(Object.entries(l).map(([k, v]) => [k, String(v)])) : {};
}

// A volume is a host mount when its source is a path rather than a named volume.
function hostMount(v: unknown): boolean {
  if (typeof v === "string") {
    const src = v.split(":")[0];
    return v.includes(":") && /^([./~]|\$)/.test(src);
  }
  return isObj(v) && (v.type === "bind" || v.type === "npipe");
}

export function checkCompose(text: string): ComposeCheck {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = load(text);
  } catch (e) {
    return { errors: [`The compose file isn't valid YAML: ${(e as Error).message.split("\n")[0]}`], services: [], exposed: [] };
  }
  if (!isObj(doc) || !isObj(doc.services) || !Object.keys(doc.services).length) return { errors: ["The compose file has no services"], services: [], exposed: [] };
  const services: string[] = [];
  const exposed: ExposedService[] = [];
  for (const [name, raw] of Object.entries(doc.services)) {
    if (!isObj(raw)) {
      errors.push(`${name}: not a service definition`);
      continue;
    }
    const svc = raw;
    const bad = (why: string) => errors.push(`${name}: ${why}`);
    if (svc.privileged === true) bad("privileged mode isn't allowed");
    for (const k of ["network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup"]) if (svc[k] === "host") bad(`${k}: host isn't allowed`);
    if (Array.isArray(svc.cap_add) && svc.cap_add.length) bad("cap_add isn't allowed");
    if (svc.devices) bad("devices aren't allowed");
    if (svc.device_cgroup_rules) bad("device_cgroup_rules aren't allowed");
    if (Array.isArray(svc.volumes) && svc.volumes.some(hostMount)) bad("host mounts aren't allowed (use named volumes)");
    if (Array.isArray(svc.security_opt) && svc.security_opt.some((o) => /unconfined|label[:=]disable/.test(String(o)))) bad("unconfined security options aren't allowed");
    if (Array.isArray(svc.ports))
      for (const p of svc.ports) {
        const s = isObj(p) ? `${p.host_ip ?? ""}:${p.published ?? ""}` : String(p);
        const published = isObj(p) ? p.published !== undefined : String(p).includes(":");
        if (published && !LOOPBACK.test(s)) bad(`port ${String(isObj(p) ? p.published : p)} is published beyond loopback (Mynt serves labelled services itself)`);
      }
    const build = isObj(svc.build) ? svc.build.context : svc.build;
    if (typeof build === "string" && (build.startsWith("/") || build.split("/").includes(".."))) bad("the build context must be inside the repository");
    if (!svc.build && !svc.image) bad("needs a build or an image");
    const inProfile = Array.isArray(svc.profiles) && svc.profiles.length > 0;
    if (!inProfile) services.push(name);
    const l = labels(svc);
    if (l["mynt.expose"] !== undefined && !inProfile) {
      const port = Number(l["mynt.port"]);
      if (!EXPOSE_NAME.test(l["mynt.expose"])) bad("mynt.expose must be a short lowercase name, e.g. web or api");
      else if (!Number.isInteger(port) || port < 1 || port > 65535) bad("mynt.port must be the port the service listens on");
      else exposed.push({ service: name, expose: l["mynt.expose"], port });
    }
  }
  if (!exposed.length && !errors.length) errors.push("No service is labelled mynt.expose (with mynt.port), so there's nothing to serve");
  if (new Set(exposed.map((e) => e.expose)).size !== exposed.length) errors.push("Two services share a mynt.expose name");
  return { errors, services, exposed };
}

// What Mynt layers on top: every default service without privilege escalation and limited, and each exposed
// service published on the VM port Mynt routes to. Capabilities stay at Docker's defaults (cap_add is refused), so
// ordinary services such as a database still start. JSON is valid compose YAML.
export function composeOverride(check: ComposeCheck, ports: Record<string, number>): string {
  const services: Obj = {};
  for (const name of check.services) {
    const e = check.exposed.find((x) => x.service === name);
    services[name] = {
      security_opt: ["no-new-privileges:true"],
      mem_limit: "1g",
      cpus: 1,
      restart: "unless-stopped",
      ...(e ? { ports: [`${ports[e.expose]}:${e.port}`] } : {}),
    };
  }
  return JSON.stringify({ services }, null, 2);
}
