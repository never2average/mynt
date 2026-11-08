#!/usr/bin/env node
// Runs the sponsored US product flow (scripts/sponsored-product.mjs) against a Mynt server, over MCP.
//
//   node scripts/apply-sponsored-product.mjs --url <mynt MCP URL> [--fixture <file.json>] [--dry-run] [--staging] [--verify-licences]
//
// Each person acts in their own session, its access token read from the environment (never the command line,
// never printed, never written to disk): MYNT_ADMIN_TOKEN (an admin), MYNT_LICENCE_PROVIDER_TOKEN (the licence
// provider's person) and MYNT_BUILDER_TOKEN (the builder). Set only the ones there are: the run does what those
// people can and stops, saying who's needed next; run it again once they've acted and it picks up from there.
//
// --fixture defaults to schemas/examples/us/sponsored-product.placeholder.json, a placeholder for staging and tests
// only, refused without --staging. --verify-licences: the admin running it has checked every licence in the fixture
// against the regulator's public register, so the run verifies them (otherwise it stops for review_license).
// --dry-run reads only and lists what it would do. The MCP URL can also come from MYNT_MCP_URL.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_FIXTURE, loadFixture, runSponsoredProduct } from "./sponsored-product.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "usage: node scripts/apply-sponsored-product.mjs --url <mynt MCP URL> [--fixture <file.json>] [--dry-run] [--staging] [--verify-licences]";

if (args.some((a) => /^--?(token|bearer|auth)/i.test(a))) {
  console.error("Refusing a token on the command line (it would land in shell history and process lists). Set MYNT_ADMIN_TOKEN, MYNT_LICENCE_PROVIDER_TOKEN and MYNT_BUILDER_TOKEN.");
  process.exit(2);
}
const url = option("--url") ?? process.env.MYNT_MCP_URL;
const tokens = Object.fromEntries(
  Object.entries({ admin: process.env.MYNT_ADMIN_TOKEN, licence_provider: process.env.MYNT_LICENCE_PROVIDER_TOKEN, builder: process.env.MYNT_BUILDER_TOKEN })
    .map(([k, v]) => [k, v?.trim()])
    .filter(([, v]) => v),
);
if (!url || !Object.keys(tokens).length) {
  console.error(`${!url ? "No MCP URL (--url). " : ""}${!Object.keys(tokens).length ? "Set at least one of MYNT_ADMIN_TOKEN, MYNT_LICENCE_PROVIDER_TOKEN, MYNT_BUILDER_TOKEN. " : ""}\n${usage}`);
  process.exit(2);
}

// Anything shown to the operator has every token scrubbed, whatever the server echoes back.
const scrub = (s) => Object.values(tokens).reduce((out, t) => out.split(t).join("[access token]"), String(s));
const say = (s) => console.log(scrub(s));
const shout = (s) => console.error(scrub(s));

const clients = {};
let exitCode = 0;
try {
  for (const [actor, token] of Object.entries(tokens)) {
    const client = new Client({ name: `apply-sponsored-product-${actor}`, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients[actor] = client;
  }
  const call = async (name, input, actor) => {
    const res = await clients[actor].callTool({ name, arguments: input });
    const text = res.content?.[0]?.text ?? "";
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: Boolean(res.isError), data };
  };
  const fixture = loadFixture(option("--fixture") ?? DEFAULT_FIXTURE);
  const result = await runSponsoredProduct({ call, fixture, actors: Object.keys(clients), dryRun: flag("--dry-run"), staging: flag("--staging"), verifyLicences: flag("--verify-licences"), say });
  if (result.dry_run) for (const step of result.plan) say(`  would: ${step}`);
  if (result.done) say(`Done: '${fixture.product.id}' is developer-ready.`);
  else {
    say(`Not done yet: stopped at ${result.stopped_at}${result.waiting_on ? `, waiting on the ${result.waiting_on.replace("_", " ")}` : ""}. ${result.reason ?? ""}`);
    if (!result.dry_run) exitCode = 3;
  }
} catch (e) {
  shout(e instanceof Error ? e.message : e);
  exitCode = 1;
} finally {
  await Promise.all(Object.values(clients).map((c) => c.close()));
}
process.exit(exitCode);
