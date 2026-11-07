#!/usr/bin/env node
// Gives Mynt reference products their v2 definitions, as an admin, over MCP.
//
//   node scripts/apply-seed-definitions.mjs --url <mynt MCP URL> --login [--dry-run] [file.v2.json ...]
//   MYNT_ADMIN_TOKEN=... node scripts/apply-seed-definitions.mjs --url <mynt MCP URL> [--dry-run] [file.v2.json ...]
//
// With no files it applies every schemas/examples/seed/*.v2.json. It checks all of them first
// (check_product_definition with the product id) and stops, changing nothing, if any is invalid or has
// publish blockers, printing why. Then, for each: set_product_definition, test_product and
// publish_product, one line per product. A product whose live definition already matches the file is
// skipped. --dry-run stops after the checks.
//
// Signing in: --login signs you in through the browser (see mynt-login.mjs) and keeps the access token
// in memory only; otherwise the token is read from MYNT_ADMIN_TOKEN. Either way it is never accepted on
// the command line, never printed and never written to disk. The MCP URL can also come from MYNT_MCP_URL.

import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { login } from "./mynt-login.mjs";
import { applySeedDefinitions, checkSeedDefinitions } from "./seed-definitions.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "usage: node scripts/apply-seed-definitions.mjs --url <mynt MCP URL> (--login | with MYNT_ADMIN_TOKEN set) [--dry-run] [file.v2.json ...]";

if (args.some((a) => /^--?(token|bearer|auth)/i.test(a))) {
  console.error("Refusing a token on the command line (it would land in shell history and process lists). Use --login, or set MYNT_ADMIN_TOKEN.");
  process.exit(2);
}
const url = option("--url") ?? process.env.MYNT_MCP_URL;
const useLogin = flag("--login");
const envToken = process.env.MYNT_ADMIN_TOKEN?.trim();
if (!url || (!useLogin && !envToken)) {
  console.error(`${!url ? "No MCP URL (--url). " : ""}${!useLogin && !envToken ? "Add --login to sign in through your browser, or set MYNT_ADMIN_TOKEN. " : ""}\n${usage}`);
  process.exit(2);
}
const dryRun = flag("--dry-run");
const valueArgs = new Set([option("--url")].filter(Boolean));
let files = args.filter((a) => !a.startsWith("--") && !valueArgs.has(a));
if (!files.length) {
  const dir = new URL("../schemas/examples/seed/", import.meta.url);
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".v2.json"))
    .sort()
    .map((f) => new URL(f, dir).pathname);
}

let token;
try {
  token = useLogin ? await login({ mcpUrl: url }) : envToken;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// Anything shown to the operator has the token scrubbed, whatever the server echoes back.
const scrub = (s) => String(s).split(token).join("[access token]");
const say = (s) => console.log(scrub(s));
const shout = (s) => console.error(scrub(s));

const client = new Client({ name: "apply-seed-definitions", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
} catch (e) {
  shout(`Couldn't connect to Mynt at ${url}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

async function call(name, input) {
  const res = await client.callTool({ name, arguments: input });
  const text = res.content?.[0]?.text ?? "";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  return { isError: Boolean(res.isError), data };
}

let exitCode = 0;
try {
  // 1. Check every definition; change nothing unless all of them pass. 2. Save, test and publish each.
  const defs = files.map((f) => ({ file: basename(f), def: JSON.parse(readFileSync(f, "utf8")) }));
  const { ready } = await checkSeedDefinitions({ call, defs, say, shout });
  if (!ready) {
    shout("Stopped: nothing was changed. Fix the definitions or the regulatory model, then run again.");
    exitCode = 1;
  } else if (dryRun) {
    say(`Dry run: ${defs.length} definition(s) checked, nothing changed.`);
  } else await applySeedDefinitions({ call, defs, say });
} catch (e) {
  shout(e instanceof Error ? e.message : e);
  exitCode = 1;
} finally {
  await client.close();
}
process.exit(exitCode);
