#!/usr/bin/env node
// Gives Mynt reference products their v2 definitions, as an admin, over MCP.
//
//   MYNT_ADMIN_TOKEN=... node scripts/apply-seed-definitions.mjs --url <mynt MCP URL> [--dry-run] [file.v2.json ...]
//
// With no files it applies every schemas/examples/seed/*.v2.json. It checks all of them first
// (check_product_definition with the product id) and stops, changing nothing, if any is invalid or has
// publish blockers, printing why. Then, for each: set_product_definition, test_product and
// publish_product, one line per product. A product whose live definition already matches the file is
// skipped. --dry-run stops after the checks.
//
// The admin token is read from MYNT_ADMIN_TOKEN only: never pass it on the command line, and it is never
// printed. The MCP URL can also come from MYNT_MCP_URL.

import { readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "usage: MYNT_ADMIN_TOKEN=... node scripts/apply-seed-definitions.mjs --url <mynt MCP URL> [--dry-run] [file.v2.json ...]";

if (args.some((a) => /^--?(token|bearer|auth)/i.test(a))) {
  console.error("Refusing a token on the command line (it would land in shell history and process lists). Set MYNT_ADMIN_TOKEN instead.");
  process.exit(2);
}
const token = process.env.MYNT_ADMIN_TOKEN?.trim();
const url = option("--url") ?? process.env.MYNT_MCP_URL;
if (!token || !url) {
  console.error(`${!token ? "MYNT_ADMIN_TOKEN isn't set. " : ""}${!url ? "No MCP URL. " : ""}\n${usage}`);
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

// Anything shown to the operator has the token scrubbed, whatever the server echoes back.
const scrub = (s) => String(s).split(token).join("[MYNT_ADMIN_TOKEN]");
const say = (s) => console.log(scrub(s));
const shout = (s) => console.error(scrub(s));

const client = new Client({ name: "apply-seed-definitions", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

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

const stable = (v) =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

let exitCode = 0;
try {
  // 1. Check every definition; change nothing unless all of them pass.
  const defs = files.map((f) => ({ file: f, def: JSON.parse(readFileSync(f, "utf8")) }));
  let refused = false;
  for (const { file, def } of defs) {
    const r = await call("check_product_definition", { product_id: def._id, definition: def });
    const blockers = r.data.publish_blockers ?? [];
    if (r.isError || !r.data.valid || blockers.length) {
      refused = true;
      shout(`${def._id}: NOT READY (${file})`);
      if (r.data.error) shout(`  ${r.data.error}`);
      for (const e of r.data.errors ?? []) shout(`  error: ${e}`);
      for (const b of blockers) shout(`  publish blocker: ${b.key} (${b.primitive} ${b.action}, ${b.region}): ${b.reason}`);
    } else {
      const warnings = r.data.warnings ?? [];
      say(`${def._id}: valid, no publish blockers; catalogue cites ${r.data.catalogue_record?.regulator} in ${r.data.catalogue_record?.region}${warnings.length ? `; warnings: ${warnings.join("; ")}` : ""}`);
    }
  }
  if (refused) {
    shout("Stopped: nothing was changed. Fix the definitions or the regulatory model, then run again.");
    exitCode = 1;
  } else if (dryRun) {
    say(`Dry run: ${defs.length} definition(s) checked, nothing changed.`);
  } else {
    // 2. Save, test and publish each.
    for (const { def } of defs) {
      const current = await call("get_product_definition", { product_id: def._id });
      if (!current.isError && current.data.live_definition_hash && same(current.data.definition, def)) {
        say(`${def._id}: unchanged (live definition already matches), skipped`);
        continue;
      }
      const step = async (name, input) => {
        const r = await call(name, input);
        if (r.isError) throw new Error(`${def._id}: ${name} failed: ${JSON.stringify(r.data)}`);
        return r.data;
      };
      await step("set_product_definition", { product_id: def._id, definition: def, changelog: "v2 definition for Mynt's reference catalogue" });
      const tested = await step("test_product", { id: def._id });
      if (!tested.passed) throw new Error(`${def._id}: test_product failed: ${JSON.stringify(tested.checks.filter((c) => c.status === "fail"))}`);
      const live = await step("publish_product", { id: def._id });
      const contract = await call("get_developer_contract", { product_id: def._id });
      const c = contract.data;
      say(
        contract.isError
          ? `${def._id}: published version ${live.version ?? "?"}, but its contract couldn't be read: ${c.error}`
          : `${def._id}: published version ${c.version}; contract ${c.contract_hash} with ${c.offers.length} offer(s), ${c.actions.length} action(s)`,
      );
    }
  }
} catch (e) {
  shout(e instanceof Error ? e.message : e);
  exitCode = 1;
} finally {
  await client.close();
}
process.exit(exitCode);
