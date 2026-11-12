import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { createMcpHttpServer } from "../dist/http.js";
import { clientSdkFiles } from "./fixtures/generate-client-sdks.mjs";

// Kotlin, Swift and Dart are compiled in CI (the client-sdks job); here: every file is generated with its
// contract filled in, and the React Native client typechecks, hashes correctly and runs against the API.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("every device SDK is generated with the app's contract filled in", async () => {
  const { files } = await clientSdkFiles();
  const file = (p) => files.find((f) => f.path === p)?.content;
  for (const p of [
    "react-native/src/index.ts",
    "react-native/src/sha256.ts",
    "react-native/package.json",
    "kotlin/src/main/kotlin/mynt/saver_kit/MyntClient.kt",
    "swift/Package.swift",
    "swift/Sources/SaverKit/MyntClient.swift",
    "flutter/pubspec.yaml",
    "flutter/lib/saver_kit.dart",
  ])
    assert.ok(file(p), `${p} is generated`);
  for (const f of files) assert.doesNotMatch(f.content, /__[A-Z_]+__/, `${f.path} has an unfilled placeholder`);

  const kotlin = file("kotlin/src/main/kotlin/mynt/saver_kit/MyntClient.kt");
  assert.match(kotlin, /^package mynt\.saver_kit$/m);
  assert.match(kotlin, /val CLIENT_ACTIONS: Map<String, List<String>> = mapOf\("everyday-rd" to listOf\("view_offers", "mandate_setup"\)\)/);
  assert.match(kotlin, /val DOCUMENTS: Map<String, List<String>> = mapOf\("everyday-rd" to listOf\("kfs"\)\)/);
  assert.match(kotlin, /const val DEFAULT_BASE_URL = "https:\/\/mynt\.example\.com\/v1"/);
  const swift = file("swift/Sources/SaverKit/MyntClient.swift");
  assert.match(swift, /public static let consentPurposes: \[String: \[String\]\] = \["everyday-rd": \["mandate_setup"\]\]/);
  assert.match(file("swift/Package.swift"), /name: "SaverKit"/);
  const dart = file("flutter/lib/saver_kit.dart");
  assert.match(dart, /static const Map<String, List<String>> clientActions = \{"everyday-rd": \["view_offers", "mandate_setup"\]\};/);
  assert.match(file("flutter/pubspec.yaml"), /^name: saver_kit$/m);
  // No client SDK carries an app key or talks to the server-only routes.
  for (const p of ["react-native/src/index.ts", "kotlin/src/main/kotlin/mynt/saver_kit/MyntClient.kt", "swift/Sources/SaverKit/MyntClient.swift", "flutter/lib/saver_kit.dart"])
    assert.doesNotMatch(file(p), /\/client_sessions|apiKey/, p);
});

test("the React Native client typechecks, hashes like WebCrypto, and runs against the API", async () => {
  const { ctx, files } = await clientSdkFiles();
  const file = (p) => files.find((f) => f.path === p).content;
  const dir = mkdtempSync(join(ROOT, "node_modules", ".mynt-rn-sdk-"));
  scratch.push(dir);
  const sources = { "index.ts": file("react-native/src/index.ts"), "sha256.ts": file("react-native/src/sha256.ts"), "schema.d.ts": file("react-native/src/schema.d.ts") };
  for (const [n, c] of Object.entries(sources)) writeFileSync(join(dir, n), c);
  const program = ts.createProgram(Object.keys(sources).map((f) => join(dir, f)), {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
    types: [],
    skipLibCheck: true,
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  assert.doesNotMatch(sources["index.ts"], /crypto\.subtle/, "no WebCrypto on React Native");

  const emit = (name) => ts.transpileModule(sources[name], { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  writeFileSync(join(dir, "sha256.js"), emit("sha256.ts"));
  writeFileSync(join(dir, "index.mjs"), emit("index.ts"));
  const { sha256Hex } = await import(pathToFileURL(join(dir, "sha256.js")).href);
  // Padding boundaries (55, 56, 63, 64 bytes), multi-block input and non-ASCII text.
  for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "x".repeat(1000), "Key facts: ₹ 7.1% p.a. — नियम"])
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), `length ${text.length}`);

  // Against the live API: the RN client reads offers and records a document with the right hash.
  await ctx.call(ctx.client, "set_product_access", { id: "everyday-rd", access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" } });
  const { user } = await ctx.store.createUser("Dev", ["developer"]);
  const dev = await ctx.connect(user);
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] })).data;
  const key = (await ctx.call(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).data.key;
  const http = createMcpHttpServer(ctx.store, null, {}, { publicUrl: "https://mynt.test" }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  try {
    const base = `http://127.0.0.1:${http.address().port}`;
    const minted = await (
      await fetch(`${base}/v1/client_sessions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ product_ids: ["everyday-rd"], customer_ref: "rn_1" }) })
    ).json();
    const rn = await import(pathToFileURL(join(dir, "index.mjs")).href);
    const device = rn.createMyntBrowserClient({ clientSecret: minted.client_secret, baseUrl: `${base}/v1` });
    assert.equal((await device.offers()).products[0].product_id, "everyday-rd");
    await device.documentShown("everyday-rd", "kfs", "Key facts: ₹ 7.1% p.a.");
    const [e] = await ctx.store.clientEvidence(app.id);
    assert.equal(e.content_hash, `sha256:${createHash("sha256").update("Key facts: ₹ 7.1% p.a.").digest("hex")}`);
  } finally {
    http.closeAllConnections();
    http.close();
  }
});
