import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, `${name.toLowerCase()}@example.com`]);
    return { ...user, email: `${name.toLowerCase()}@example.com` };
  };
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text, text };
    }
    return { isError: res.isError ?? false, data };
  };
  return { pg, store, as, connect, call };
}

const product = (over = {}) => ({
  id: "green-fd",
  name: "Green Fixed Deposit",
  product_line: "account_operations",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Fixed deposit whose proceeds fund certified renewable-energy projects.",
  key_features: ["Fixed rate", "Funds green projects"],
  ...over,
});

const indexFund = {
  id: "index-fund-x",
  name: "Index Fund X",
  product_line: "wealth",
  category: "mutual_funds",
  return_type: "market_linked",
  risk_level: "high",
  liquidity: "high",
  typical_horizon: "long",
  regulator: "SEBI",
  description: "Index fund tracking a broad market index with low costs.",
  key_features: ["Low cost", "Diversified"],
};

async function publishedBy(ctx, name, over = {}) {
  const user = await ctx.as(name, ["innovator"]);
  await licensed(ctx.store, user, { region: "IN", category: over.category ?? "deposits", action: "issuance" });
  const client = await ctx.connect(user);
  const id = over.id ?? "green-fd";
  assert.equal((await ctx.call(client, "create_product", product(over))).isError, false);
  await ctx.call(client, "test_product", { id });
  const published = await ctx.call(client, "publish_product", { id });
  assert.equal(published.isError, false, JSON.stringify(published.data));
  return { user, client };
}

const FD_TERMS = {
  permitted_actions: ["display", "compare", "deep_link"],
  required_disclosures: ["Deposits are insured up to the statutory limit", 'Rates can change; "see" the <b>terms</b> & conditions'],
  banned_phrases: ["risk-free"],
  branding: "Issued by Green Bank Ltd, a regulated bank",
};
const FUND_TERMS = {
  permitted_actions: ["display", "compare", "deep_link", "initiate_onboarding"],
  required_disclosures: ["Mutual fund investments are subject to market risks; read all scheme documents carefully."],
  banned_phrases: ["guaranteed returns"],
  branding: "Index Fund X by Amc Ltd",
};

// Two innovators with open products and a developer.
async function market() {
  const ctx = await setup();
  const ines = await publishedBy(ctx, "Ines");
  await ctx.call(ines.client, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: FD_TERMS });
  const amc = await publishedBy(ctx, "Amc", indexFund);
  await ctx.call(amc.client, "set_product_access", { id: "index-fund-x", access_mode: "open", build_terms: FUND_TERMS });
  const devUser = await ctx.as("Dev", ["developer"]);
  const dev = await ctx.connect(devUser);
  return { ...ctx, ines, amc, devUser, dev };
}

const fileOf = (release, path) => release.files.find((f) => f.path === path)?.content;

// Scratch dirs live under node_modules so generated code resolves openapi-fetch like an installed SDK would.
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratchDir = (prefix) => {
  const d = mkdtempSync(join(ROOT, "node_modules", `.${prefix}`));
  scratch.push(d);
  return d;
};

function typecheck(files) {
  const dir = scratchDir("mynt-sdk-ts-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const program = ts.createProgram(
    Object.keys(files).map((f) => join(dir, f)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      typeRoots: [join(ROOT, "node_modules/@types")],
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? d.file.fileName.split("/").pop() : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("SDKs only cover products the developer may build on", async () => {
  const ctx = await market();
  const pat = await publishedBy(ctx, "Pat", { id: "secret-fd", name: "Secret FD" });
  await ctx.call(pat.client, "set_product_access", { id: "secret-fd", access_mode: "private" });
  await publishedBy(ctx, "Ana", { id: "approval-fd", name: "Approval FD" });

  assert.equal((await ctx.call(ctx.dev, "create_sdk", { name: "Kit", languages: [], product_ids: ["green-fd"] })).isError, true, "a language is required");
  assert.match((await ctx.call(ctx.dev, "create_sdk", { name: "Kit", languages: ["typescript"], product_ids: ["secret-fd"] })).data.error, /no access/);
  assert.match((await ctx.call(ctx.dev, "create_sdk", { name: "Kit", languages: ["typescript"], product_ids: ["nope"] })).data.error, /not published/);
  // Approval products can be built on before approval; open ones freely.
  const sdk = (await ctx.call(ctx.dev, "create_sdk", { name: "Kit", languages: ["typescript"], product_ids: ["green-fd", "approval-fd"] })).data;
  assert.deepEqual(sdk.product_ids, ["green-fd", "approval-fd"]);

  // An invitation opens a private product.
  await ctx.call(pat.client, "invite_developer", { product_id: "secret-fd", developer_email: "dev@example.com" });
  assert.equal((await ctx.call(ctx.dev, "create_sdk", { name: "Kit 2", languages: ["python"], product_ids: ["secret-fd"] })).isError, false);

  // Someone else's SDK is invisible.
  const other = await ctx.connect(await ctx.as("Other", ["developer"]));
  assert.equal((await ctx.call(other, "generate_sdk_release", { sdk_id: sdk.id, version: "1.0.0", changelog: "First" })).isError, true);
  assert.deepEqual((await ctx.call(other, "list_sdks")).data, []);

  // get_product_sdk points at generated clients.
  assert.match((await ctx.call(ctx.dev, "get_product_sdk", { product_id: "green-fd" })).data.integration.generated_clients, /create_sdk/);
});

test("generated SDK: OpenAPI contract, openapi-fetch TypeScript client, Python helpers and generator", async () => {
  const ctx = await market();
  const sdk = (await ctx.call(ctx.dev, "create_sdk", { name: "Saver kit", languages: ["typescript", "python"], product_ids: ["green-fd", "index-fund-x"] })).data;
  const gen = await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "1.0.0", changelog: "First release" });
  assert.equal(gen.isError, false, JSON.stringify(gen.data));
  assert.deepEqual(gen.data.sources.map((s) => [s.product_id, s.version]), [["green-fd", 1], ["index-fund-x", 1]]);

  const release = (await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: sdk.id })).data;
  assert.equal(release.stale, false);
  assert.deepEqual(release.files.map((f) => f.path).sort(), [
    "README.md",
    "openapi.json",
    "python/README.md",
    "python/config.yml",
    "python/generate.sh",
    "python/mynt_helpers.py",
    "typescript/package.json",
    "typescript/src/browser.ts",
    "typescript/src/index.ts",
    "typescript/src/schema.d.ts",
    "typescript/tsconfig.json",
  ]);

  // OpenAPI 3.1 with the contract's paths and a schema per product from its actual fields.
  const doc = JSON.parse(fileOf(release, "openapi.json"));
  assert.equal(doc.openapi, "3.1.0");
  assert.match(doc.servers[0].url, /\/v1$/);
  assert.ok(doc.paths["/products"].get && doc.paths["/products/{id}"].get && doc.paths["/handoffs"].post && doc.paths["/events"].post);
  assert.ok(doc.paths["/products"].get.responses["429"].headers["Retry-After"]);
  assert.equal(doc.components.securitySchemes.appKey.scheme, "bearer");
  const fd = doc.components.schemas.GreenFdProduct;
  assert.equal(fd.properties.id.const, "green-fd");
  for (const k of [...Object.keys(product()), "version", "build_terms"]) assert.ok(fd.properties[k], k);
  assert.deepEqual(fd.properties.key_features, { type: "array", items: { type: "string" } });
  assert.deepEqual(fd["x-mynt-required-disclosures"], FD_TERMS.required_disclosures);
  assert.ok(doc.components.schemas.IndexFundXProduct);
  assert.deepEqual(doc.components.schemas.HandoffRequest.properties.action.enum, ["deep_link", "initiate_onboarding"]);
  assert.deepEqual(doc.components.schemas.Event.properties.type.enum, ["view", "click", "handoff_started"]);
  assert.ok(doc.webhooks["handoff.completed"] && doc.webhooks["access.revoked"]);

  // TypeScript: openapi-typescript types + openapi-fetch client + Mynt helpers, pinned to Mynt's own versions.
  const pkgJson = JSON.parse(fileOf(release, "typescript/package.json"));
  const mynt = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkgJson.dependencies, { "openapi-fetch": mynt.devDependencies["openapi-fetch"] });
  assert.equal(pkgJson.devDependencies["openapi-typescript"], mynt.dependencies["openapi-typescript"]);
  const schema = fileOf(release, "typescript/src/schema.d.ts");
  assert.match(schema, /openapi-typescript/);
  assert.match(schema, /export interface paths/);
  assert.match(schema, /GreenFdProduct: \{/);
  const index = fileOf(release, "typescript/src/index.ts");
  assert.ok(index.includes(JSON.stringify(FD_TERMS.required_disclosures[1])), "disclosures as constants");
  assert.ok(index.includes(JSON.stringify(FD_TERMS.branding)));
  assert.ok(index.includes(JSON.stringify(FD_TERMS.banned_phrases[0])));
  assert.match(index, /export function disclosuresFor/);
  assert.match(index, /from "openapi-fetch"/);
  assert.doesNotMatch(index, /\bfetch\(/, "no hand-rolled requests");
  const usage = `import { createMyntClient, disclosuresFor, verifyWebhook, BRANDING, type GreenFdProduct } from "./index.js";
const c = createMyntClient({ apiKey: "mynt_test_x" });
export async function run(): Promise<string> {
  const { data } = await c.client.GET("/products/{id}", { params: { path: { id: "green-fd" } } });
  const p = data as GreenFdProduct;
  await c.startHandoff("green-fd", "deep_link");
  await c.startHandoff("index-fund-x", "initiate_onboarding", "ref-1");
  await c.trackEvent("view", "green-fd", "home");
  const d: readonly string[] = disclosuresFor("index-fund-x");
  verifyWebhook("{}", "t=1,v1=00", "s");
  return p.name + p.key_features.join() + d.join() + BRANDING["green-fd"];
}
`;
  const sources = { "schema.d.ts": schema, "index.ts": index };
  assert.deepEqual(typecheck({ ...sources, "usage.ts": usage }), []);
  const misuse = `import type { MyntClient } from "./index.js";
export const go = (c: MyntClient) => c.startHandoff("green-fd", "initiate_onboarding");
`;
  const errors = typecheck({ ...sources, "misuse.ts": misuse });
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /^misuse\.ts/);

  // ...and runs on openapi-fetch: hand-offs hit the contract, errors surface, webhooks verify.
  const dir = scratchDir("mynt-sdk-js-");
  const js = ts.transpileModule(index, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  writeFileSync(join(dir, "index.mjs"), js);
  const mod = await import(pathToFileURL(join(dir, "index.mjs")).href);
  const seen = [];
  const fakeFetch = async (req) => {
    seen.push({ url: req.url, auth: req.headers.get("Authorization"), body: await req.text() });
    if (req.url.endsWith("/events")) return new Response(null, { status: 202 });
    return Response.json({ handoff_id: "h1", redirect_url: "https://issuer.example.com/start" });
  };
  const client = mod.createMyntClient({ apiKey: "mynt_test_abc", baseUrl: "https://mynt.example.com/v1", fetch: fakeFetch });
  assert.equal(client.sandbox, true);
  assert.equal((await client.startHandoff("green-fd", "deep_link", "u1")).handoff_id, "h1");
  assert.equal(seen[0].url, "https://mynt.example.com/v1/handoffs");
  assert.equal(seen[0].auth, "Bearer mynt_test_abc");
  assert.deepEqual(JSON.parse(seen[0].body), { product_id: "green-fd", action: "deep_link", consumer_ref: "u1" });
  await assert.rejects(client.startHandoff("green-fd", "initiate_onboarding"), /does not permit/);
  await client.trackEvent("click", "green-fd");
  assert.equal(seen.length, 2);
  assert.throws(() => mod.createMyntClient({ apiKey: "sk_nope" }), /app key/);
  const limited = mod.createMyntClient({
    apiKey: "mynt_live_x",
    fetch: async () => Response.json({ error: "rate_limited", message: "Slow down" }, { status: 429 }),
  });
  await assert.rejects(limited.startHandoff("index-fund-x", "deep_link"), (e) => e.status === 429 && e.code === "rate_limited");
  const body = JSON.stringify({ type: "handoff.completed", data: { handoff_id: "h1" } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsec").update(`${t}.${body}`).digest("hex");
  assert.equal(mod.verifyWebhook(body, `t=${t},v1=${sig}`, "whsec").type, "handoff.completed");
  assert.throws(() => mod.verifyWebhook(body, `t=${t},v1=${sig}`, "wrong"), /Invalid/);
  assert.throws(() => mod.verifyWebhook(body.replace("h1", "h2"), `t=${t},v1=${sig}`, "whsec"), /Invalid/, "tampered body");
  const old = t - 3600;
  assert.throws(() => mod.verifyWebhook(body, `t=${old},v1=${createHmac("sha256", "whsec").update(`${old}.${body}`).digest("hex")}`, "whsec"), /tolerance/);
  assert.deepEqual(mod.disclosuresFor("green-fd"), FD_TERMS.required_disclosures);

  // Python: openapi-python-client generates the client; the hand-written helpers are standard library only.
  assert.match(fileOf(release, "python/generate.sh"), /openapi-python-client generate --path \.\.\/openapi\.json/);
  assert.match(fileOf(release, "python/config.yml"), /package_name_override: "saver_kit"/);
  const py = fileOf(release, "python/mynt_helpers.py");
  assert.match(py, /def disclosures_for/);
  assert.match(py, /def verify_webhook/);
  assert.ok(py.includes(JSON.stringify(FD_TERMS.branding)));
  if (!hasPython) return;
  const pyDir = mkdtempSync(join(tmpdir(), "mynt-sdk-py-"));
  for (const f of release.files) {
    mkdirSync(dirname(join(pyDir, f.path)), { recursive: true });
    writeFileSync(join(pyDir, f.path), f.content);
  }
  execFileSync("python3", ["-m", "py_compile", join(pyDir, "python", "mynt_helpers.py")]);
  const script = `
import json, sys
sys.path.insert(0, sys.argv[3])
import mynt_helpers as k
body, header = sys.argv[1], sys.argv[2]
ev = k.verify_webhook(body, header, "whsec")
def rejects(f):
    try:
        f()
        return False
    except ValueError:
        return True
print(json.dumps({"type": ev["type"], "wrong_secret": rejects(lambda: k.verify_webhook(body, header, "wrong")),
  "tampered": rejects(lambda: k.verify_webhook(body + " ", header, "whsec")),
  "handoff": rejects(lambda: k.check_handoff("green-fd", "initiate_onboarding")),
  "disclosures": list(k.disclosures_for("green-fd")), "banned": list(k.BANNED_PHRASES["index-fund-x"]), "handoffs": list(k.PERMITTED_HANDOFFS["index-fund-x"])}))
`;
  const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, body, `t=${t},v1=${sig}`, join(pyDir, "python")]).toString());
  assert.deepEqual(out, {
    type: "handoff.completed",
    wrong_secret: true,
    tampered: true,
    handoff: true,
    disclosures: FD_TERMS.required_disclosures,
    banned: FUND_TERMS.banned_phrases,
    handoffs: ["deep_link", "initiate_onboarding"],
  });

  // When openapi-python-client is installed (never a Mynt dependency), generate the client and import it.
  // OPENAPI_PYTHON_CLIENT may point at the CLI inside a virtualenv; its python then imports the result.
  const generator = process.env.OPENAPI_PYTHON_CLIENT || "openapi-python-client";
  if (spawnSync(generator, ["--version"]).status !== 0) return;
  execFileSync(generator, ["generate", "--path", "../openapi.json", "--config", "config.yml", "--meta", "setup", "--overwrite"], { cwd: join(pyDir, "python"), stdio: "pipe" });
  const python = process.env.OPENAPI_PYTHON_CLIENT ? join(dirname(generator), "python") : "python3";
  const imports = `
import sys
sys.path.insert(0, sys.argv[1])
from saver_kit import AuthenticatedClient
from saver_kit.api.default import list_products, start_handoff
from saver_kit.models import GreenFixedDeposit, HandoffRequest
c = AuthenticatedClient(base_url="https://mynt.example.com/v1", token="mynt_test_x")
print(type(c).__name__, GreenFixedDeposit.__name__, HandoffRequest.__name__, callable(start_handoff.sync), callable(list_products.sync))
`;
  assert.equal(execFileSync(python, ["-c", imports, join(pyDir, "python", "saver-kit")]).toString().trim(), "AuthenticatedClient GreenFixedDeposit HandoffRequest True True");
});

test("SDK releases are immutable and versions only go up", async () => {
  const ctx = await market();
  const sdk = (await ctx.call(ctx.dev, "create_sdk", { name: "Kit", languages: ["typescript"], product_ids: ["green-fd"] })).data;
  assert.equal((await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: sdk.id })).isError, true, "no releases yet");
  assert.equal((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "v1", changelog: "First" })).isError, true, "semver");
  await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "1.0.0", changelog: "First" });
  assert.match((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "1.0.0", changelog: "Again" })).data.error, /greater than 1.0.0/);
  assert.match((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "0.9.9", changelog: "Older" })).data.error, /greater/);
  await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "1.10.0", changelog: "Second" });
  assert.equal((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "1.9.0", changelog: "Not semver-greater" })).isError, true);

  assert.deepEqual((await ctx.call(ctx.dev, "list_sdk_releases", { sdk_id: sdk.id })).data.map((r) => r.version), ["1.10.0", "1.0.0"]);
  assert.equal((await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: sdk.id })).data.version, "1.10.0");
  const first = (await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: sdk.id, version: "1.0.0" })).data;
  assert.match(fileOf(first, "typescript/src/index.ts"), /SDK_VERSION = "1\.0\.0"/);
  await assert.rejects(ctx.pg.query("UPDATE financial_products.sdk_releases SET changelog = 'tampered'"), /immutable/);
  assert.equal((await ctx.call(ctx.dev, "list_sdks")).data[0].latest_version, "1.10.0");
});

test("SDK releases go stale when products change, terms change, products leave or access is revoked", async () => {
  const ctx = await market();
  const sdk = (await ctx.call(ctx.dev, "create_sdk", { name: "Kit", languages: ["python"], product_ids: ["green-fd"] })).data;
  let n = 0;
  const release = async () => (await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: `1.${n++}.0`, changelog: "Regenerate" })).data;
  const staleness = async () => (await ctx.call(ctx.dev, "list_sdks")).data[0];
  await release();
  assert.equal((await staleness()).stale, false);

  // A new product version.
  await ctx.call(ctx.ines.client, "create_product_version", { id: "green-fd", changelog: "Better rate", description: "Fixed deposit funding certified renewable-energy projects, now at a better rate." });
  await ctx.call(ctx.ines.client, "test_product", { id: "green-fd" });
  assert.equal((await ctx.call(ctx.ines.client, "publish_product", { id: "green-fd" })).isError, false);
  let s = await staleness();
  assert.equal(s.stale, true);
  assert.match(s.stale_reasons.join(), /version 2/);
  const r2 = await release();
  assert.equal(r2.sources[0].version, 2);
  assert.equal((await staleness()).stale, false);
  assert.equal((await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: sdk.id, version: "1.0.0" })).data.stale, true, "older releases stay stale");

  // New build terms.
  await ctx.call(ctx.ines.client, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: { ...FD_TERMS, banned_phrases: ["risk-free", "best rate"] } });
  s = (await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: sdk.id })).data;
  assert.equal(s.stale, true);
  assert.match(s.stale_reasons.join(), /build terms/);
  await release();
  assert.equal((await staleness()).stale, false);

  // Unpublished.
  await ctx.call(ctx.ines.client, "unpublish_product", { id: "green-fd" });
  assert.match((await staleness()).stale_reasons.join(), /unpublished/);
  assert.equal((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: sdk.id, version: "9.0.0", changelog: "Try" })).isError, true);

  // Revoked access on an approval product.
  const app = (await ctx.call(ctx.dev, "create_app", { name: "Funds", description: "Funds", audience: "Investors", product_ids: ["index-fund-x"] })).data;
  await ctx.call(ctx.amc.client, "set_product_access", { id: "index-fund-x", access_mode: "approval", build_terms: FUND_TERMS });
  const req = (await ctx.call(ctx.dev, "request_product_access", { app_id: app.id, product_id: "index-fund-x" })).data;
  await ctx.call(ctx.amc.client, "review_request", { request_id: req.id, decision: "approve" });
  const fundSdk = (await ctx.call(ctx.dev, "create_sdk", { name: "Funds kit", languages: ["typescript"], product_ids: ["index-fund-x"] })).data;
  assert.equal((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: fundSdk.id, version: "1.0.0", changelog: "First" })).data.sources[0].access, "approved");
  assert.equal((await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: fundSdk.id })).data.stale, false);
  await ctx.call(ctx.amc.client, "revoke_access", { request_id: req.id, reason: "Breached our terms" });
  const revoked = (await ctx.call(ctx.dev, "get_sdk_release", { sdk_id: fundSdk.id })).data;
  assert.equal(revoked.stale, true);
  assert.match(revoked.stale_reasons.join(), /revoked/);
  assert.equal((await ctx.call(ctx.dev, "generate_sdk_release", { sdk_id: fundSdk.id, version: "1.1.0", changelog: "Try" })).isError, true);
});

const screen = (id, components, title = "Save") => ({ id, title, components });
const card = (product_id) => ({ type: "product_card", product_id });
const disclose = (product_id) => ({ type: "disclosure_block", product_id });
const cta = (product_id, action, label = "Open an account") => ({ type: "handoff_cta", product_id, action, label });

async function appWith(ctx, product_ids = ["green-fd", "index-fund-x"]) {
  return (await ctx.call(ctx.dev, "create_app", { name: "Goal saver", description: "Savings and investing for goals", audience: "Salaried savers", product_ids })).data;
}

test("experience definitions are validated", async () => {
  const ctx = await market();
  const app = await appWith(ctx);
  const bad = async (experience) => (await ctx.call(ctx.dev, "set_experience", { app_id: app.id, experience })).isError;
  assert.equal(await bad({ screens: [] }), true);
  assert.equal(await bad({ screens: [screen("home", [{ type: "video", url: "x" }])] }), true, "unknown component");
  assert.equal(await bad({ screens: [screen("home", [{ type: "calculator", product_id: "green-fd", kind: "irr" }])] }), true, "unknown calculator");
  assert.equal(await bad({ screens: [screen("home", [cta("green-fd", "collect_payment")])] }), true, "hand-offs only");
  assert.equal(await bad({ screens: [screen("home", [{ type: "comparison_table", product_ids: ["green-fd"] }])] }), true, "compare two or more");
  assert.equal(await bad({ screens: [screen("home", [card("green-fd")]), screen("home", [card("green-fd")])] }), true, "duplicate screen id");
  assert.equal(await bad({ screens: [screen("Home Page", [card("green-fd")])] }), true, "screen id format");
  const ok = await ctx.call(ctx.dev, "set_experience", { app_id: app.id, experience: { screens: [screen("home", [card("green-fd"), disclose("green-fd")])] } });
  assert.equal(ok.isError, false);
  const other = await ctx.connect(await ctx.as("Other", ["developer"]));
  assert.equal((await ctx.call(other, "set_experience", { app_id: app.id, experience: { screens: [screen("home", [{ type: "text", content: "x" }])] } })).isError, true);

  // A saved experience that stops validating fails the check instead of skipping it.
  await ctx.store.setAppExperience(app.id, { screens: [{ id: "home", title: "Home", components: [{ type: "hologram" }] }] });
  const checked = (await ctx.call(ctx.dev, "check_experience", { app_id: app.id })).data;
  assert.equal(checked.ready, false);
  assert.equal(checked.structure.checks[0].name, "experience_valid");
});

test("structural checks: each one fails, then passes, and publish_app enforces them", async () => {
  const ctx = await market();
  const app = await appWith(ctx);
  const check = async (experience) => {
    await ctx.call(ctx.dev, "set_experience", { app_id: app.id, experience });
    const r = (await ctx.call(ctx.dev, "check_experience", { app_id: app.id })).data;
    return { ready: r.ready, failed: r.structure.checks.filter((c) => c.status === "fail").map((c) => `${c.name}:${c.product_id}`).sort() };
  };

  const good = {
    screens: [
      screen("home", [
        { type: "text", content: "Grow your savings towards a goal." },
        { type: "comparison_table", product_ids: ["green-fd", "index-fund-x"] },
        disclose("green-fd"),
        disclose("index-fund-x"),
      ]),
      screen("fd", [card("green-fd"), { type: "calculator", product_id: "green-fd", kind: "maturity" }, cta("green-fd", "deep_link"), disclose("green-fd")]),
      screen("fund", [card("index-fund-x"), { type: "calculator", product_id: "index-fund-x", kind: "sip" }, cta("index-fund-x", "initiate_onboarding", "Start investing"), disclose("index-fund-x")]),
    ],
  };
  assert.deepEqual(await check(good), { ready: true, failed: [] });
  // Disclosure blocks render the required disclosures, so the terms lint passes without app.disclosures.
  const full = (await ctx.call(ctx.dev, "check_experience", { app_id: app.id })).data;
  assert.ok(full.lint.checks.filter((c) => c.name === "disclosures").every((c) => c.status === "pass"));

  // A screen shows a product without its disclosure block.
  const noBlock = structuredClone(good);
  noBlock.screens[1].components.pop();
  assert.deepEqual((await check(noBlock)).failed, ["screen_disclosures:green-fd"]);

  // No disclosure block for a product anywhere.
  const neverDisclosed = { screens: [screen("home", [card("green-fd"), disclose("green-fd")]), screen("fund", [card("index-fund-x")])] };
  assert.deepEqual((await check(neverDisclosed)).failed, ["disclosures_rendered:index-fund-x", "screen_disclosures:index-fund-x"]);

  // A CTA the product doesn't permit.
  const badCta = structuredClone(good);
  badCta.screens[1].components[2] = cta("green-fd", "initiate_onboarding");
  assert.deepEqual((await check(badCta)).failed, ["component_actions:green-fd"]);

  // A comparison over a product that doesn't permit compare.
  await ctx.call(ctx.ines.client, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: { ...FD_TERMS, permitted_actions: ["display", "deep_link"] } });
  assert.deepEqual((await check(good)).failed, ["component_actions:green-fd"]);
  await ctx.call(ctx.ines.client, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: FD_TERMS });

  // A product that isn't in the app.
  const outside = structuredClone(good);
  outside.screens[0].components.push(card("ppf"), disclose("ppf"));
  assert.deepEqual((await check(outside)).failed, ["component_products:*"]);

  // Banned wording in text, labels and titles.
  const bannedText = structuredClone(good);
  bannedText.screens[0].components[0].content = "A Risk-Free way to save";
  assert.deepEqual((await check(bannedText)).failed, ["experience_banned_phrases:green-fd"]);
  const bannedLabel = structuredClone(good);
  bannedLabel.screens[2].components[2].label = "Guaranteed returns, start now";
  assert.deepEqual((await check(bannedLabel)).failed, ["experience_banned_phrases:index-fund-x"]);

  // publish_app refuses structural failures (and keeps the other checks).
  await check(badCta);
  const refused = await ctx.call(ctx.dev, "publish_app", { app_id: app.id });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.data.failed_checks.map((c) => c.name), ["component_actions"]);
  await ctx.call(ctx.dev, "update_app", { app_id: app.id, name: "Risk-free saver" });
  assert.ok((await ctx.call(ctx.dev, "publish_app", { app_id: app.id })).data.failed_checks.some((c) => c.name === "banned_phrases"));
  await ctx.call(ctx.dev, "update_app", { app_id: app.id, name: "Goal saver" });
  await check(good);
  assert.equal((await ctx.call(ctx.dev, "publish_app", { app_id: app.id })).data.status, "published");
});

test("experience preview is self-contained, escaped HTML with disclosures and branding", async () => {
  const ctx = await market();
  const app = await appWith(ctx);
  assert.equal((await ctx.call(ctx.dev, "render_experience_preview", { app_id: app.id })).isError, true, "no experience yet");
  await ctx.call(ctx.dev, "set_experience", {
    app_id: app.id,
    experience: {
      screens: [
        screen("home", [
          { type: "text", content: `<script>alert("x")</script><img src=x onerror=alert(1)>` },
          card("green-fd"),
          cta("green-fd", "deep_link", `Open "now" <b>`),
          disclose("green-fd"),
        ], "Start <here>"),
      ],
    },
  });
  const res = await ctx.dev.callTool({ name: "render_experience_preview", arguments: { app_id: app.id } });
  const html = res.content[0].text;
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("Start &lt;here&gt;"));
  assert.ok(html.includes("Open &quot;now&quot; &lt;b&gt;"));
  assert.doesNotMatch(html, /(src|href)=["']?(https?:)?\/\//i, "no external assets");
  assert.ok(html.includes("Deposits are insured up to the statutory limit"));
  assert.ok(html.includes("Rates can change; &quot;see&quot; the &lt;b&gt;terms&lt;/b&gt; &amp; conditions"), "disclosures verbatim, escaped");
  assert.ok(html.includes("Issued by Green Bank Ltd, a regulated bank"));
  assert.ok(html.includes("Offered by Ines Ltd"));
  assert.ok(html.includes("Green Fixed Deposit"));
});

test("developers get the build tools", async () => {
  const ctx = await setup();
  const tools = (await (await ctx.connect(await ctx.as("Dev", ["developer"]))).listTools()).tools.map((t) => t.name);
  for (const t of ["create_sdk", "generate_sdk_release", "list_sdks", "list_sdk_releases", "get_sdk_release", "set_experience", "render_experience_preview"]) {
    assert.ok(tools.includes(t), t);
  }
  const guest = (await (await ctx.connect(null)).listTools()).tools.map((t) => t.name);
  assert.ok(!guest.includes("create_sdk"));
});
