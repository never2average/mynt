import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Device SDKs beyond the web: React Native, Kotlin (Android), Swift (iOS) and Flutter (Dart). Each is the
// same client as the browser one (client sessions, offers, evidence, hosted actions, the customer vault,
// journeys and a headless journey runner), generated from source templates in sdk-templates/ with the
// app's contract constants (products, client actions, consent purposes, documents) filled in.

export interface ClientData {
  ids: string[];
  clientActions: (readonly [string, string[]])[];
  consents: (readonly [string, string[]])[];
  documents: (readonly [string, string[]])[];
}
interface GeneratedFile {
  path: string;
  content: string;
}

const TEMPLATES = fileURLToPath(new URL("../sdk-templates/", import.meta.url));
const template = (path: string) => readFileSync(TEMPLATES + path, "utf8");
const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce((t, [k, v]) => t.split(k).join(v), text);

// String literals: JSON's escaping, plus $ (string interpolation in Kotlin and Dart).
const str = (s: string) => JSON.stringify(s).replace(/\$/g, "\\$");
const words = (slug: string) => slug.split(/[^a-z0-9]+/i).filter(Boolean);
export const kotlinPackage = (slug: string) => "mynt." + (words(slug).join("_").toLowerCase().replace(/^(\d)/, "sdk_$1") || "sdk");
export const swiftModule = (slug: string) => (words(slug).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "MyntSdk").replace(/^(\d)/, "Sdk$1");
export const dartPackage = (slug: string) => (words(slug).join("_").toLowerCase() || "mynt_sdk").replace(/^(\d)/, "sdk_$1");

function kotlinContract(d: ClientData): string {
  const list = (xs: string[]) => `listOf(${xs.map(str).join(", ")})`;
  const map = (rows: ClientData["clientActions"]) => (rows.length ? `mapOf(${rows.map(([k, v]) => `${str(k)} to ${list(v)}`).join(", ")})` : "emptyMap()");
  return [
    `    val PRODUCT_IDS: List<String> = ${list(d.ids)}`,
    `    val CLIENT_ACTIONS: Map<String, List<String>> = ${map(d.clientActions)}`,
    `    val CONSENT_PURPOSES: Map<String, List<String>> = ${map(d.consents)}`,
    `    val DOCUMENTS: Map<String, List<String>> = ${map(d.documents)}`,
  ].join("\n");
}

function swiftContract(d: ClientData): string {
  const list = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  const map = (rows: ClientData["clientActions"]) => (rows.length ? `[${rows.map(([k, v]) => `${JSON.stringify(k)}: ${list(v)}`).join(", ")}]` : "[:]");
  return [
    `    public static let productIds: [String] = ${list(d.ids)}`,
    `    public static let clientActions: [String: [String]] = ${map(d.clientActions)}`,
    `    public static let consentPurposes: [String: [String]] = ${map(d.consents)}`,
    `    public static let documents: [String: [String]] = ${map(d.documents)}`,
  ].join("\n");
}

function dartContract(d: ClientData): string {
  const list = (xs: string[]) => `[${xs.map(str).join(", ")}]`;
  const map = (rows: ClientData["clientActions"]) => `{${rows.map(([k, v]) => `${str(k)}: ${list(v)}`).join(", ")}}`;
  return [
    `  static const List<String> productIds = ${list(d.ids)};`,
    `  static const Map<String, List<String>> clientActions = ${map(d.clientActions)};`,
    `  static const Map<String, List<String>> consentPurposes = ${map(d.consents)};`,
    `  static const Map<String, List<String>> documents = ${map(d.documents)};`,
  ].join("\n");
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export function kotlinSdk(opts: { name: string; version: string; baseUrl: string; slug: string; data: ClientData }): GeneratedFile[] {
  const pkg = kotlinPackage(opts.slug);
  const source = fill(template("kotlin/MyntClient.kt"), {
    __SDK_NAME__: opts.name,
    __SDK_VERSION__: opts.version,
    __KOTLIN_PACKAGE__: pkg,
    __BASE_URL__: `${opts.baseUrl}/v1`,
    __KOTLIN_CONTRACT__: kotlinContract(opts.data),
  });
  return [
    { path: `kotlin/src/main/kotlin/${pkg.replace(/\./g, "/")}/MyntClient.kt`, content: source },
    {
      path: "kotlin/README.md",
      content: `# Kotlin (Android)

Package \`${pkg}\`: \`MyntClient(clientSecret)\` on a client session your server minted, and \`JourneyRunner\`.
Calls block: run them off the main thread (\`withContext(Dispatchers.IO) { … }\`). On Android everything it
uses is built in; on a plain JVM add \`org.json:json\`.

\`\`\`kotlin
val mynt = MyntClient(clientSecret = sessionFromYourServer)
val runner = JourneyRunner(mynt, "journey_id")
runner.complete(StepInput(documents = mapOf("kfs" to shownText)))
\`\`\`
`,
    },
  ];
}

export function swiftSdk(opts: { name: string; version: string; baseUrl: string; slug: string; data: ClientData }): GeneratedFile[] {
  const module = swiftModule(opts.slug);
  const values = { __SDK_NAME__: opts.name, __SDK_VERSION__: opts.version, __SWIFT_MODULE__: module, __BASE_URL__: `${opts.baseUrl}/v1`, __SWIFT_CONTRACT__: swiftContract(opts.data) };
  return [
    { path: "swift/Package.swift", content: fill(template("swift/Package.swift"), values) },
    { path: `swift/Sources/${module}/MyntClient.swift`, content: fill(template("swift/MyntClient.swift"), values) },
    {
      path: "swift/README.md",
      content: `# Swift (iOS, macOS)

Swift package \`${module}\`: \`MyntClient(clientSecret:)\` on a client session your server minted, and \`JourneyRunner\`.

\`\`\`swift
let mynt = try MyntClient(clientSecret: sessionFromYourServer)
let runner = try await JourneyRunner(client: mynt, journeyId: "journey_id")
try await runner.complete(StepInput(documents: ["kfs": shownText]))
\`\`\`
`,
    },
  ];
}

export function flutterSdk(opts: { name: string; version: string; baseUrl: string; slug: string; data: ClientData }): GeneratedFile[] {
  const pkg = dartPackage(opts.slug);
  const values = { __SDK_NAME__: opts.name, __SDK_VERSION__: opts.version, __DART_PACKAGE__: pkg, __BASE_URL__: `${opts.baseUrl}/v1`, __DART_CONTRACT__: dartContract(opts.data) };
  return [
    { path: "flutter/pubspec.yaml", content: fill(template("flutter/pubspec.yaml"), values) },
    { path: `flutter/lib/${pkg}.dart`, content: fill(template("flutter/mynt_client.dart"), values) },
    {
      path: "flutter/README.md",
      content: `# Flutter (Dart)

Package \`${pkg}\`: \`MyntClient(clientSecret: …)\` on a client session your server minted, and \`JourneyRunner\`.

\`\`\`dart
final mynt = MyntClient(clientSecret: sessionFromYourServer);
final runner = await JourneyRunner.start(mynt, 'journey_id');
await runner.complete(StepInput(documents: {'kfs': shownText}));
\`\`\`
`,
    },
  ];
}

// The browser client with WebCrypto swapped for a plain-TypeScript SHA-256 (React Native has no
// crypto.subtle without a native module).
const WEBCRYPTO_HASH = `export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}`;
export function reactNativeSdk(opts: { name: string; version: string; slug: string; browserSource: string; schema: string; openapiFetchVersion: string }): GeneratedFile[] {
  if (!opts.browserSource.includes(WEBCRYPTO_HASH)) throw new Error("browser client changed: update the React Native hash swap");
  const source = opts.browserSource
    .replace(WEBCRYPTO_HASH, `export async function hashText(text: string): Promise<string> {\n  return "sha256:" + sha256Hex(text);\n}`)
    .replace('import type { components, paths } from "./schema.js";', 'import type { components, paths } from "./schema.js";\nimport { sha256Hex } from "./sha256.js";')
    .replace("Uses only web APIs (fetch, WebCrypto).", "React Native: fetch, and SHA-256 in plain TypeScript.");
  return [
    { path: "react-native/src/index.ts", content: source },
    { path: "react-native/src/sha256.ts", content: template("react-native/sha256.ts") },
    { path: "react-native/src/schema.d.ts", content: opts.schema },
    {
      path: "react-native/package.json",
      content: json({
        name: `${opts.slug}-react-native`,
        version: opts.version,
        main: "dist/index.js",
        types: "dist/index.d.ts",
        scripts: { build: "tsc" },
        dependencies: { "openapi-fetch": opts.openapiFetchVersion },
        peerDependencies: { "react-native": ">=0.72" },
        devDependencies: { typescript: "^5.9.0" },
      }),
    },
    {
      path: "react-native/tsconfig.json",
      content: json({ compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2020", "DOM"], strict: true, declaration: true, rootDir: "src", outDir: "dist" }, include: ["src"] }),
    },
    {
      path: "react-native/README.md",
      content: `# React Native

The browser client for React Native: \`createMyntBrowserClient({ clientSecret })\` on a client session your
server minted, and \`createJourneyRunner\`. Hashing is plain TypeScript, so no native module is needed.
`,
    },
  ];
}
