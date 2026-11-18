#!/usr/bin/env node
// Writes Mynt's treasury template at another program id, the way Mynt rebuilds it to verify a pool's program:
//   node scripts/treasury-at.mjs <program id> <dir>       -> <dir>/solana/... (the layout solana-verify.sh builds)
//   node scripts/treasury-at.mjs check <program id> <out>  -> checks <out>'s programs.json/checks.jsonl as Mynt does
// Run after `npm run build` (it uses dist/). CI's solana-treasury job builds the template at a fresh id with it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTemplateBuild, readTreasuryManifest, treasuryTemplateAt } from "../dist/treasury-template.js";

const [a, b, c] = process.argv.slice(2);
if (a === "check") {
  const read = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const r = readTemplateBuild(read(join(c, "programs.json")), read(join(c, "checks.jsonl")), b, readTreasuryManifest());
  console.log(JSON.stringify(r));
  process.exit("error" in r ? 1 : 0);
}
if (!a || !b) {
  console.error("usage: treasury-at.mjs <program id> <dir> | check <program id> <out>");
  process.exit(2);
}
for (const [path, text] of Object.entries(treasuryTemplateAt(a))) {
  const to = join(b, "solana", path);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text);
}
console.log(`wrote the treasury template at ${a} to ${join(b, "solana")}`);
