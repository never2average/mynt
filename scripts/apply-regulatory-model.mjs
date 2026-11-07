#!/usr/bin/env node
// Sets up a region's regulatory model on a Mynt server, as an admin, over MCP: product categories, regulated
// product types, the law the obligations cite, the regulators with their licence types and GRC, and the
// region's standard services. The model is data, in schemas/regulatory/<region>.json.
//
//   node scripts/apply-regulatory-model.mjs --url <mynt MCP URL> --login [--dry-run] [--allow-removals] [schemas/regulatory/us.json]
//   MYNT_ADMIN_TOKEN=... node scripts/apply-regulatory-model.mjs --url <mynt MCP URL> [--dry-run] [--allow-removals] [file]
//
// It merges the file into what the server has, never replacing it: for each item it reads the server's version,
// deep-merges the file into it by id (licence types, personas, product-type mappings, GRC registers and
// repositories, legislation...) and sends the merged whole, so nothing the file leaves out is lost. A file can
// therefore hold only additions (schemas/regulatory/in.additions.json). See scripts/regulatory-model.mjs.
//
// It checks every merged item against the server's own tool schemas first and changes nothing if any is wrong,
// printing why. It prints, per item, what would be added, updated and removed. The only removals merging can make
// are entries of plain lists the file gives without them (an action, a covered state) and service types the
// shipped examples would overwrite; any of those refuses the run unless --allow-removals is given, and they are
// listed either way. --dry-run stops after printing the plan.
//
// Signing in works exactly like apply-seed-definitions.mjs: --login through the browser, or MYNT_ADMIN_TOKEN.
// A token is never accepted on the command line, printed or written to disk.

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { login } from "./mynt-login.mjs";
import { applyRegulatoryModel, formatPlan } from "./regulatory-model.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "usage: node scripts/apply-regulatory-model.mjs --url <mynt MCP URL> (--login | with MYNT_ADMIN_TOKEN set) [--dry-run] [--allow-removals] [schemas/regulatory/us.json]";

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
const allowRemovals = flag("--allow-removals");
const valueArgs = new Set([option("--url")].filter(Boolean));
const file = args.find((a) => !a.startsWith("--") && !valueArgs.has(a)) ?? new URL("../schemas/regulatory/us.json", import.meta.url).pathname;
const model = JSON.parse(readFileSync(file, "utf8"));

let token;
try {
  token = useLogin ? await login({ mcpUrl: url }) : envToken;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const scrub = (s) => String(s).split(token).join("[access token]");
const say = (s) => console.log(scrub(s));
const shout = (s) => console.error(scrub(s));

const client = new Client({ name: "apply-regulatory-model", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
} catch (e) {
  shout(`Couldn't connect to Mynt at ${url}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const call = async (name, input) => {
  const res = await client.callTool({ name, arguments: input });
  const text = res.content?.[0]?.text ?? "";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  return { isError: Boolean(res.isError), data };
};
const listTools = async () => (await client.listTools()).tools;

const tally = (plan) => {
  const n = (c) => plan.filter((p) => p.change === c).length;
  return `${n("add")} to add, ${n("update") + n("load")} to update, ${n("keep")} unchanged, ${plan.reduce((k, p) => k + p.removed.length, 0)} removal(s)`;
};

let exitCode = 0;
try {
  say("Signed in.");
  const r = await applyRegulatoryModel({ call, listTools, model, dryRun, allowRemovals, say });
  for (const line of formatPlan(r.plan)) say(line);
  if (r.removals.length && allowRemovals) say(`--allow-removals: ${r.removals.length} removal(s) listed above ${r.applied ? "were made" : "would be made"}.`);
  if (r.problems.length) {
    for (const p of r.problems) shout(`problem: ${p}`);
    shout("Stopped: nothing was changed.");
    exitCode = 1;
  } else if (!r.applied) say(`Dry run: ${r.plan.length} step(s) checked (${tally(r.plan)}), nothing changed.`);
  else say(`Done: ${model.region}'s regulatory model is set up (${r.plan.length} steps: ${tally(r.plan)}). Loaded service types: ${(r.services?.loaded ?? []).join(", ") || "none"}.`);
} catch (e) {
  shout(e instanceof Error ? e.message : e);
  shout("Stopped part-way. The steps above that say done were applied; running the script again merges the file in again.");
  exitCode = 1;
} finally {
  await client.close();
}
process.exit(exitCode);
