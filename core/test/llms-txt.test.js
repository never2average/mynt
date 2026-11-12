import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { GET_STARTED } from "../dist/llms-txt.js";
import { ROLES, Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const PUBLIC = "https://mynt.example.test";
// A made-up value, assembled at run time so no secret scanner mistakes it for a real key.
const FAKE_SECRET = ["fake", "secret", "llms", "txt", "never", "shown"].join("-");

let store, http, base, pg;
before(async () => {
  process.env.LLMS_TXT_TEST_SECRET_KEY = FAKE_SECRET;
  pg = new PGlite();
  store = await Store.open({ query: (sql, params) => pg.query(sql, params), exec: (sql) => pg.exec(sql), close: () => pg.close() }, CATALOG);
  http = createMcpHttpServer(store, null, {}, { publicUrl: PUBLIC }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  base = `http://127.0.0.1:${http.address().port}`;
});
after(async () => {
  delete process.env.LLMS_TXT_TEST_SECRET_KEY;
  http.close();
  await pg.close();
});

const get = async (path, init) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

// The registry itself: what a signed-in user of `role` lists over MCP.
async function registryTools(role) {
  const user = (await store.createUser(`registry ${role} ${Math.random()}`, [role])).user;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("llms.txt follows the llmstxt.org format and uses the configured public URL", async () => {
  const { status, headers, text } = await get("/llms.txt");
  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(headers.get("cache-control"), "public, max-age=300");
  const lines = text.split("\n");
  assert.equal(lines[0], "# Mynt");
  assert.equal(lines.filter((l) => /^# /.test(l)).length, 1, "exactly one H1");
  assert.match(lines.slice(1).find((l) => l.trim()), /^> \S/, "a blockquote summary follows the H1");
  const h2 = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
  for (const s of ["Get started", "Docs", "Optional"]) assert.ok(h2.includes(s), `has ## ${s}`);
  assert.ok(lines.length < 160, `short: ${lines.length} lines`);
  assert.ok(text.includes(`${PUBLIC}/mcp`));
  assert.ok(text.includes(`${PUBLIC}/.well-known/oauth-protected-resource/mcp`));
  assert.ok(text.includes(`${PUBLIC}/v1`));
  assert.ok(text.includes(`(${PUBLIC}/llms-full.txt)`));
  assert.ok(text.includes("https://github.com/never2average/mynt"));
  for (const role of ROLES) assert.ok(text.includes(`**${role}**`), `describes ${role}`);
  assert.ok(!/\bmerchant/i.test(text));
  assert.ok(!text.includes("127.0.0.1"), "no internal address");
});

test("every get-started tool exists in that role's real tool list", async () => {
  const text = (await get("/llms.txt")).text;
  for (const role of ROLES) {
    const names = new Set((await registryTools(role)).map((t) => t.name));
    assert.ok(GET_STARTED[role].length >= 3 && GET_STARTED[role].length <= 5);
    for (const { tool } of GET_STARTED[role]) {
      assert.ok(names.has(tool), `${role} has ${tool}`);
      assert.ok(text.includes(`\`${tool}\``));
    }
  }
});

test("/.well-known/llms.txt serves the same document", async () => {
  const a = await get("/llms.txt");
  const b = await get("/.well-known/llms.txt");
  assert.equal(b.status, 200);
  assert.equal(b.text, a.text);
  assert.equal(b.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("every link into the repository (blob/main, tree/main) names a path that exists in it", async () => {
  const root = new URL("../../", import.meta.url); // the repository root, above core/
  const links = [];
  for (const path of ["/llms.txt", "/llms-full.txt"]) {
    const { text } = await get(path);
    for (const m of text.matchAll(/https:\/\/github\.com\/never2average\/mynt\/(?:blob|tree)\/main\/([^\s)#]+)/g)) links.push(m[1]);
  }
  assert.ok(links.some((l) => l.startsWith("core/schemas/")), "links into core/ are checked");
  for (const l of new Set(links)) assert.ok(existsSync(new URL(l, root)), `${l} exists in the repository`);
});

test("llms-full.txt lists every tool of each role exactly once, from the live registry", async () => {
  const { status, headers, text } = await get("/llms-full.txt");
  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(headers.get("cache-control"), "public, max-age=300");
  assert.match(text, /^# Mynt/);
  const byRole = text.split("\n## Tools by role\n")[1].split("\n## Tool reference\n")[0];
  const reference = text.split("\n## Tool reference\n")[1].split("\n## Runtime API for apps\n")[0];
  const all = new Map();
  for (const role of ROLES) {
    const tools = await registryTools(role);
    const section = byRole.split(`\n### ${role}\n`)[1].split("\n### ")[0];
    const listed = [...section.matchAll(/^- `([a-z0-9_]+)`/gm)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), tools.map((t) => t.name).sort(), `${role}: every tool, once`);
    for (const t of tools) all.set(t.name, t);
  }
  const headings = [...reference.matchAll(/^### ([a-z0-9_]+)/gm)].map((m) => m[1]);
  assert.deepEqual(headings.sort(), [...all.keys()].sort(), "each tool described exactly once");
  for (const t of all.values()) {
    const block = reference.split(new RegExp(`^### ${escape(t.name)}\\b.*$`, "m"))[1].split(/^### /m)[0];
    if (t.description) assert.ok(block.includes(t.description.trim()), `${t.name} has its description`);
    for (const field of Object.keys(t.inputSchema?.properties ?? {})) assert.ok(block.includes(`\`${field}\``), `${t.name}.${field}`);
    for (const field of t.inputSchema?.required ?? []) assert.ok(block.includes(`\`${field}\` (`) && new RegExp(`\`${escape(field)}\` \\([^)]*required`).test(block), `${t.name}.${field} required`);
  }
  assert.ok(text.includes("## Runtime API for apps"));
  assert.ok(text.includes("`POST /v1/client_sessions`"));
  assert.ok(text.includes("## Vendor wire contract") && text.includes("Mynt-Signature"));
  assert.ok(text.includes("mynt://schemas/financial-product.v2"));
});

test("llms-full.txt holds no secrets, env values or internal addresses", async () => {
  const { text } = await get("/llms-full.txt");
  assert.ok(!text.includes(FAKE_SECRET));
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 16 && /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/.test(k)) assert.ok(!text.includes(v), `no value of ${k}`);
  }
  assert.doesNotMatch(text, /sk_(live|test)_[A-Za-z0-9]{8,}|-----BEGIN|fpm_[a-f0-9]{16,}|mynt_bd_[A-Za-z0-9]{8,}|postgres(ql)?:\/\//);
  assert.ok(!text.includes("127.0.0.1") && !text.includes("localhost"));
  assert.ok(!/\bmerchant/i.test(text));
});

test("unknown paths get a real 404 with a pointer; / answers 200", async () => {
  for (const path of ["/no-such-file.txt", "/llms-fulll.txt", "/v2/products", "/.well-known/whatever"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.text.trim(), `Not found. Mynt's MCP endpoint is ${PUBLIC}/mcp; start at ${PUBLIC}/llms.txt.`);
  }
  const root = await get("/");
  assert.equal(root.status, 200);
  assert.ok(root.text.includes(`${PUBLIC}/mcp`) && root.text.includes(`${PUBLIC}/llms.txt`));
  assert.equal((await get("/llms.txt", { method: "POST", body: "{}" })).status, 404);
  const head = await get("/llms.txt", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
});

test("existing routes are unaffected", async () => {
  assert.deepEqual([(await get("/healthz")).status, (await get("/healthz")).text], [200, "ok"]);
  assert.equal((await get("/mcp")).status, 405);
  assert.equal((await get("/v1/products")).status, 401, "runtime API still asks for an app key");
  const rpc = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(rpc.status, 200);
  const body = await rpc.text();
  assert.ok(JSON.parse(body.match(/^data: (.*)$/m)?.[1] ?? body).result.tools.some((t) => t.name === "list_products"));
});
