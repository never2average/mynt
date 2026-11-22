#!/usr/bin/env node
// Adds the app ideas Mynt ships (workspaces/coding-build/templates/ideas.seed.json) to a Mynt's database, as an
// admin, over MCP: it calls seed_app_ideas, which adds the ideas that aren't there yet and never overwrites one that
// is (edited or retired). Safe to run again. Mynt never seeds them on its own.
//
//   node scripts/seed-app-ideas.mjs --url <mynt MCP URL> --login
//   MYNT_ADMIN_TOKEN=... node scripts/seed-app-ideas.mjs --url <mynt MCP URL>
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
  const res = await client.callTool({ name: "seed_app_ideas", arguments: {} });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(text);
  const { inserted, kept } = JSON.parse(text);
  console.log(scrub(`Added ${inserted.length} idea(s)${inserted.length ? `: ${inserted.join(", ")}` : ""}. Left ${kept.length} already there as they are.`));
} catch (e) {
  console.error(scrub(e instanceof Error ? e.message : e));
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
