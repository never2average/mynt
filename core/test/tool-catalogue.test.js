import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createServer } from "../dist/server.js";
import { docsSiteFiles, DOCS_PAGES, DOCS_TOOLS, extractSection } from "../dist/docs-site.js";
import { toolCatalogue, TOOL_AREAS } from "../dist/tool-catalogue.js";
import { ROLES, Store } from "../dist/store.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let store, pg, catalogue;
before(async () => {
  pg = new PGlite();
  store = await Store.open({ query: (sql, params) => pg.query(sql, params), exec: (sql) => pg.exec(sql), close: () => pg.close() }, []);
  catalogue = await toolCatalogue(store);
});
after(async () => {
  await pg.close();
});

const listTools = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
};

test("the committed docs data matches what the live registry and the Markdown generate", async () => {
  const files = await docsSiteFiles(store, ROOT);
  for (const path of [DOCS_TOOLS, DOCS_PAGES]) {
    const committed = readFileSync(join(ROOT, path), "utf8");
    assert.ok(committed === files[path], `${path} is stale: run \`npm run build && npm run docs-data\` in core/ and commit it`);
  }
});

test("every tool the source registers is in the catalogue, except the connector agent's own", async () => {
  const names = new Set(catalogue.tools.map((t) => t.name));
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
  const literal = new Set(walk(fileURLToPath(new URL("../src", import.meta.url))).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1])));
  // A connector agent run gets the public catalogue and its own tools; no person does.
  const inert = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => null) });
  const guest = new Set(await listTools(createServer(store, null)));
  const agentOnly = (await listTools(createServer(store, null, { bd: inert, bdRun: { id: "run" } }))).filter((n) => !guest.has(n));
  assert.ok(agentOnly.length > 0);
  const missing = [...literal].filter((n) => !names.has(n) && !agentOnly.includes(n));
  assert.deepEqual(missing, []);
  for (const n of agentOnly) assert.ok(!names.has(n), `${n} is the connector agent's only`);
  assert.ok(catalogue.tools.length >= literal.size - agentOnly.length);
  // A server with no optional services lists a subset of the catalogue, with the same roles.
  for (const role of ["consumer", "vendor", "admin"]) {
    const user = (await store.createUser(`catalogue ${role}`, [role])).user;
    for (const n of await listTools(createServer(store, user))) {
      const t = catalogue.tools.find((x) => x.name === n);
      assert.ok(t, `${role}'s ${n} is in the catalogue`);
      assert.ok(t.roles.includes(role), `${n} lists ${role}`);
    }
  }
});

test("roles are the ones each tool is registered for", () => {
  const roles = (n) => catalogue.tools.find((t) => t.name === n)?.roles;
  assert.deepEqual(roles("whoami"), [...ROLES]);
  assert.deepEqual(roles("define_region"), ["admin"]);
  assert.deepEqual(roles("create_app"), ["developer", "innovator", "admin"]);
  assert.deepEqual(roles("approve_sponsorship"), ["license_provider", "admin"]);
  assert.deepEqual(roles("create_vendor_offering"), ["vendor", "admin"]);
  assert.deepEqual(roles("commit_to_pool"), ["liquidity_provider"]);
  for (const r of catalogue.roles) assert.equal(r.tools, catalogue.tools.filter((t) => t.roles.includes(r.role)).length, r.role);
});

test("every tool has an area, a description and a valid JSON Schema for its inputs", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const areas = new Set(TOOL_AREAS.map((a) => a.id));
  for (const a of catalogue.areas) assert.ok(a.tools > 0, `${a.id} has tools`);
  assert.equal(catalogue.areas.reduce((n, a) => n + a.tools, 0), catalogue.tools.length);
  for (const t of catalogue.tools) {
    assert.ok(areas.has(t.area), t.name);
    assert.ok(t.description.length > 0, `${t.name} has a description`);
    assert.ok(["read", "write", "destructive"].includes(t.access), t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.doesNotThrow(() => ajv.compile(t.inputSchema), t.name);
  }
  const access = (n) => catalogue.tools.find((t) => t.name === n)?.access;
  assert.equal(access("list_products"), "read");
  assert.equal(access("create_app"), "write");
  assert.ok(catalogue.runtime_endpoints.some((e) => e.path === "/v1/client_sessions" && e.method === "POST" && e.auth === "app key"));
});

test("pages are cut at their headings, never at a '#' inside a code block", () => {
  const md = "# A\n\nintro\n\n## B\n\nb text\n\n```\n# not a heading\n```\n\n### B1\n\nsub\n\n## C\n\nc";
  assert.equal(extractSection(md, "B").body, "b text\n\n```\n# not a heading\n```\n\n### B1\n\nsub");
  assert.equal(extractSection(md, "B", ["B1"]).body, "b text\n\n```\n# not a heading\n```");
  assert.throws(() => extractSection(md, "Missing"), /no heading/);
  const pages = JSON.parse(readFileSync(join(ROOT, DOCS_PAGES), "utf8"));
  for (const p of pages.pages) {
    assert.ok(!/\bmerchants?\b/i.test(p.markdown), p.slug);
    assert.ok(!/\]\((?!https?:|mailto:|#)/.test(p.markdown), `${p.slug}: relative links point at the repository`);
  }
});
