#!/usr/bin/env node
// Suggests vulnerability database entries (schemas/solana-vulnerabilities.json) from new RustSec advisories against
// Solana and Anchor crates and the crypto and serialization crates programs build on. It only prints suggestions,
// as JSON, for a maintainer to review, give fixtures and add by pull request; it never edits the database.
//
//   node scripts/vuln-db-suggest.mjs [--since YYYY-MM-DD] [--advisories <osv-export.json>]
//
// By default it asks OSV (https://osv.dev, which mirrors the RustSec database) for every watched crate. With
// --advisories it reads a JSON array of OSV records instead (offline, or for a test).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadVulnDb, suggestFromAdvisories, WATCHED_CRATES } from "../dist/solana/vuln-db.js";

const { values } = parseArgs({ options: { since: { type: "string" }, advisories: { type: "string" } } });
if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
  console.error("--since takes a date, YYYY-MM-DD");
  process.exit(2);
}

let advisories;
if (values.advisories) advisories = JSON.parse(readFileSync(values.advisories, "utf8"));
else {
  advisories = [];
  for (const name of WATCHED_CRATES) {
    const res = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem: "crates.io" } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`OSV answered ${res.status} for ${name}`);
      process.exit(1);
    }
    advisories.push(...((await res.json()).vulns ?? []));
  }
}
const suggestions = suggestFromAdvisories(advisories, loadVulnDb(), { since: values.since });
console.log(JSON.stringify({ database_version: loadVulnDb().version, suggestions }, null, 2));
