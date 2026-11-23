#!/usr/bin/env node
// Adds the app ideas Mynt ships (workspaces/coding-build/templates/ideas.seed.json) to a Mynt's database, as an
// admin, over MCP: it calls seed_app_ideas, which adds the ideas that aren't there yet and never overwrites one that
// is (edited or retired). Safe to run again. Mynt never seeds them on its own.
//
//   node scripts/seed-app-ideas.mjs --url <mynt MCP URL> --login
//   MYNT_ADMIN_TOKEN=... node scripts/seed-app-ideas.mjs --url <mynt MCP URL>
//
// --seed v2 adds the v2 set (ideas.v2.seed.json) instead of v1; --replace then retires every active idea not in
// that set (never deletes). --products also adds the shipped financial product ideas (seed_product_ideas).
// --labels-only adds nothing: it fills in the set's chip labels (and, with --products, the product ideas') on rows
// already there that have none, and never overwrites one (labels_only on both tools).
//
// Signing in: --login signs you in through the browser (see mynt-login.mjs) and keeps the access token in memory
// only; otherwise the token is read from MYNT_ADMIN_TOKEN. Either way it is never accepted on the command line,
// never printed and never written to disk. The MCP URL can also come from MYNT_MCP_URL.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { login } from "./mynt-login.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "usage: node scripts/seed-app-ideas.mjs --url <mynt MCP URL> (--login | with MYNT_ADMIN_TOKEN set)";

if (args.some((a) => /^--?(token|bearer|auth)/i.test(a))) {
  console.error("Refusing a token on the command line (it would land in shell history and process lists). Use --login, or set MYNT_ADMIN_TOKEN.");
  process.exit(2);
}
const url = option("--url") ?? process.env.MYNT_MCP_URL;
const useLogin = args.includes("--login");
const envToken = process.env.MYNT_ADMIN_TOKEN?.trim();
if (!url || (!useLogin && !envToken)) {
  console.error(`${!url ? "No MCP URL (--url). " : ""}${!useLogin && !envToken ? "Add --login to sign in through your browser, or set MYNT_ADMIN_TOKEN. " : ""}\n${usage}`);
  process.exit(2);
}

let token;
try {
  token = useLogin ? await login({ mcpUrl: url }) : envToken;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const scrub = (s) => String(s).split(token).join("[access token]");

const client = new Client({ name: "seed-app-ideas", version: "1" });
let exitCode = 0;
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const seed = option("--seed");
  if (seed && seed !== "v1" && seed !== "v2") throw new Error(`--seed is v1 or v2, not '${seed}'`);
  const labelsOnly = args.includes("--labels-only");
  if (labelsOnly && args.includes("--replace")) throw new Error("--labels-only fills in chip labels only; run --replace on its own");
  const seedArgs = { ...(seed ? { seed } : {}), ...(args.includes("--replace") ? { replace: true } : {}), ...(labelsOnly ? { labels_only: true } : {}) };
  const run = async (name, toolArgs, what) => {
    const res = await client.callTool({ name, arguments: toolArgs });
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) throw new Error(text);
    if (labelsOnly) {
      const { filled, kept, missing } = JSON.parse(text);
      console.log(
        scrub(
          `Filled in the chip label of ${filled.length} ${what}${filled.length ? `: ${filled.join(", ")}` : ""}. Left ${kept.length} that had one as they are.` +
            (missing.length ? ` Not in the database (not added): ${missing.join(", ")}.` : ""),
        ),
      );
      return;
    }
    const { inserted, kept, retired } = JSON.parse(text);
    console.log(
      scrub(
        `Added ${inserted.length} ${what}${inserted.length ? `: ${inserted.join(", ")}` : ""}. Left ${kept.length} already there as they are.` +
          (retired ? ` Retired ${retired.length}${retired.length ? `: ${retired.join(", ")}` : ""}.` : ""),
      ),
    );
  };
  await run("seed_app_ideas", seedArgs, "app idea(s)");
  if (args.includes("--products")) await run("seed_product_ideas", labelsOnly ? { labels_only: true } : {}, "product idea(s)");
} catch (e) {
  console.error(scrub(e instanceof Error ? e.message : e));
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
