import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mynt's Caddy site (deploy/host/render-site.sh): without a studio upstream it's exactly what it
// always was; with one, every path Mynt serves still reaches Mynt and everything else reaches
// Mynt Studio. Routes are checked with Caddy itself when it's available (CADDY_DOCKER_IMAGE, or a
// caddy binary), and otherwise with a small evaluator over the rendered site.

const DOMAIN = "mynt.example.com";
const PORT = "3100";
const STUDIO = "studio.example.com";
const MYNT = `127.0.0.1:${PORT}`;

function render(...args) {
  const r = spawnSync("bash", ["deploy/host/render-site.sh", ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// A path Mynt serves for each route in src/http.ts (and the runtime API under /v1).
const MYNT_PATHS = [
  "/mcp",
  "/healthz",
  "/llms.txt",
  "/.well-known/llms.txt",
  "/llms-full.txt",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/v1",
  "/v1/client/offers",
  "/v1/client_sessions",
  "/v1/hosting/bootstrap",
  "/v1/ramp-adapters/partner/webhook",
  "/ramp-sandbox/session",
  "/agent/v1/messages",
  "/bd/unsubscribe",
];
const STUDIO_PATHS = ["/", "/2b0c6a52-app", "/2b0c6a52-app/9f1e-build", "/api/chat", "/api/auth/login", "/api/auth/callback", "/api/session", "/_next/static/chunks/main.js", "/favicon.ico"];

test("without a studio upstream, the site is exactly as before", () => {
  const expected = readFileSync("deploy/host/site.caddy", "utf8").replaceAll("@DOMAIN@", DOMAIN).replaceAll("@PORT@", PORT);
  const r = render(DOMAIN, PORT);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, expected);
});

test("refuses hosts that aren't plain host names", () => {
  for (const bad of ["https://studio.example.com", "studio.example.com/path", "studio.example.com:443", "studio example", "-x.example.com", "studio"]) {
    assert.equal(render(DOMAIN, PORT, bad).status, 2, bad);
  }
  assert.equal(render("bad domain", PORT).status, 2);
  assert.equal(render(DOMAIN, "http").status, 2);
});

test("every path literal Mynt routes in src/http.ts is among the paths checked here", () => {
  const http = readFileSync("src/http.ts", "utf8");
  const constants = {
    RAMP_SANDBOX_PATH: /RAMP_SANDBOX_PATH = "([^"]+)"/.exec(readFileSync("src/ramp-sandbox.ts", "utf8"))[1],
    RAMP_ADAPTER_WEBHOOK_PATH: /RAMP_ADAPTER_WEBHOOK_PATH = "([^"]+)"/.exec(readFileSync("src/ramp-adapters/index.ts", "utf8"))[1],
  };
  const literals = [
    ...[...http.matchAll(/pathname === "([^"]+)"/g)].map((m) => m[1]),
    ...[...http.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...http.matchAll(/pathname\.startsWith\(`\$\{(\w+)\}([^`]*)`\)/g)].map((m) => constants[m[1]] + m[2]),
    ...[...http.matchAll(/pathname\.startsWith\((RAMP_\w+)\)/g)].map((m) => constants[m[1]]),
  ].filter((p) => p !== "/"); // "/" is the studio's once it's on this domain
  assert.ok(literals.length >= 10, `found only ${literals.length} paths in src/http.ts`);
  for (const lit of literals) {
    assert.ok(MYNT_PATHS.some((p) => p === lit || p.startsWith(lit)), `src/http.ts routes ${lit}, which this test doesn't check`);
  }
});

test("with a studio upstream, it strips the caller's X-Mynt-Client-IP, sets its own, streams, and keeps Mynt's routes as they were", () => {
  const r = render(DOMAIN, PORT, STUDIO);
  assert.equal(r.status, 0, r.err);
  const studio = r.out.slice(r.out.indexOf("@mynt path"));
  assert.match(studio, /request_header -X-Mynt-Client-IP\n\t\treverse_proxy https:\/\/studio\.example\.com \{/);
  assert.match(studio, /header_up Host studio\.example\.com/);
  assert.match(studio, /header_up X-Mynt-Client-IP \{remote_host\}/);
  assert.match(studio, /flush_interval -1/);
  const before = render(DOMAIN, PORT).out;
  const myntRoutes = before.slice(0, before.indexOf("\t# Everything else"));
  assert.ok(r.out.startsWith(myntRoutes), "Mynt's own routes are unchanged");
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(readFileSync("deploy/host/studio-routes.caddy", "utf8").replaceAll("127.0.0.1", "")), "no addresses in the template");
});

test("install-host.sh takes the studio upstream as a flag, in any position, and checks it first", () => {
  const script = readFileSync("deploy/host/install-host.sh", "utf8");
  const parsing = script.slice(script.indexOf("usage='"), script.indexOf("\nfi\n", script.indexOf("--studio-upstream takes a host name")) + 4);
  const run = (...args) => {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${parsing}\necho "$DOMAIN|$REF|$STUDIO_ARG"`, "install-host.sh", ...args], { encoding: "utf8" });
    return { status: r.status, out: r.stdout.trim() };
  };
  assert.deepEqual(run(DOMAIN), { status: 0, out: `${DOMAIN}|main|` });
  assert.deepEqual(run(DOMAIN, "v1.2"), { status: 0, out: `${DOMAIN}|v1.2|` });
  assert.deepEqual(run("--studio-upstream", STUDIO, DOMAIN, "v1.2"), { status: 0, out: `${DOMAIN}|v1.2|${STUDIO}` });
  assert.deepEqual(run(DOMAIN, `--studio-upstream=${STUDIO}`), { status: 0, out: `${DOMAIN}|main|${STUDIO}` });
  assert.deepEqual(run(DOMAIN, "--no-studio"), { status: 0, out: `${DOMAIN}|main|-` });
  assert.equal(run(DOMAIN, "--studio-upstream", "https://studio.example.com").status, 2);
  assert.equal(run(DOMAIN, "--bogus").status, 2);
  assert.notEqual(run().status, 0);
});

// --- where a path goes -------------------------------------------------------------------------

const glob = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

// From Caddy's own adapted JSON: the first matching route, as Caddy evaluates them.
function routeWithCaddy(caddyfile) {
  const image = process.env.CADDY_DOCKER_IMAGE;
  const dir = mkdtempSync(join(tmpdir(), "mynt-caddy-"));
  writeFileSync(join(dir, "Caddyfile"), caddyfile);
  const r = image
    ? spawnSync("docker", ["run", "--rm", "-v", `${dir}:/w:ro`, image, "caddy", "adapt", "--adapter", "caddyfile", "--config", "/w/Caddyfile"], { encoding: "utf8" })
    : spawnSync("caddy", ["adapt", "--adapter", "caddyfile", "--config", join(dir, "Caddyfile")], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const json = JSON.parse(r.stdout);
  const routes = json.apps.http.servers.srv0.routes[0].handle.find((h) => h.handler === "subroute").routes;
  const dial = (node) => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const d = dial(n);
        if (d) return d;
      }
      return null;
    }
    if (node && typeof node === "object") {
      if (node.handler === "reverse_proxy") return node.upstreams[0].dial;
      for (const v of Object.values(node)) {
        const d = dial(v);
        if (d) return d;
      }
    }
    return null;
  };
  return (path) => {
    for (const route of routes) {
      const d = dial(route.handle);
      if (!d) continue; // e.g. the response-headers route, which doesn't end the request
      if (!route.match || route.match.some((set) => (set.path ?? []).some((p) => glob(p).test(path)))) return d;
    }
    return null;
  };
}

// Without Caddy: each handle's matcher and upstream from the rendered text. Every specific
// matcher here leads to Mynt and only the bare `handle` to the studio, so where a path goes
// doesn't depend on the order Caddy would try them in.
function routeFromText(caddyfile) {
  const named = Object.fromEntries([...caddyfile.matchAll(/^\t@(\w+) path (.+)$/gm)].map((m) => [m[1], m[2].split(" ")]));
  const blocks = [...caddyfile.matchAll(/^\thandle( [^ {]+)? \{\n([\s\S]*?)^\t\}/gm)].map((m) => {
    const matcher = m[1]?.trim();
    const upstream = /reverse_proxy (\S+)/.exec(m[2])[1].replace(/^https:\/\/(.+)$/, "$1:443");
    return { paths: matcher ? (matcher.startsWith("@") ? named[matcher.slice(1)] : [matcher]) : null, upstream };
  });
  return (path) => (blocks.find((b) => b.paths?.some((p) => glob(p).test(path))) ?? blocks.find((b) => !b.paths))?.upstream ?? null;
}

test("with a studio upstream: Mynt's paths go to Mynt, everything else to the studio", () => {
  const site = render(DOMAIN, PORT, STUDIO).out;
  const withCaddy = routeWithCaddy(site);
  const routers = [["rendered text", routeFromText(site)], ...(withCaddy ? [["caddy adapt", withCaddy]] : [])];
  if (!withCaddy) {
    assert.ok(!process.env.MYNT_REQUIRE_CADDY, "Caddy was required (MYNT_REQUIRE_CADDY) but couldn't adapt the site");
    console.log("# caddy not available: routes checked from the rendered text only");
  }
  for (const [how, route] of routers) {
    for (const p of MYNT_PATHS) assert.equal(route(p), MYNT, `${how}: ${p} should reach Mynt`);
    for (const p of STUDIO_PATHS) assert.equal(route(p), `${STUDIO}:443`, `${how}: ${p} should reach the studio`);
  }
});

test("without a studio upstream, every path still reaches Mynt", () => {
  const site = render(DOMAIN, PORT).out;
  const withCaddy = routeWithCaddy(site);
  for (const [how, route] of [["rendered text", routeFromText(site)], ...(withCaddy ? [["caddy adapt", withCaddy]] : [])]) {
    for (const p of [...MYNT_PATHS, ...STUDIO_PATHS]) assert.equal(route(p), MYNT, `${how}: ${p}`);
  }
});
