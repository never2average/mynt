// Every audit action Mynt's source can record, read from the source itself (for test/audit-classes.test.js): the
// action argument of each call to the audit helpers, and literal actions inserted into audit_log directly.
// An action given as a template literal comes back as its template text; one given as a variable as `var:<name>`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

// Which argument carries the action, by callee.
const ACTION_ARG = { "store.audit": 1, "this.store.audit": 1, "this.audit": 1, audit: 0, auditIn: 2, auditTx: 1, auditRow: 1, auditOffering: 0 };
const CALL = /(?<![\w.$])(this\.store\.audit|store\.audit|this\.audit|auditOffering|auditIn|auditTx|auditRow|audit)\(/g;

function files(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The arguments of the call whose "(" is at `open`, split at top-level commas.
function args(s, open) {
  const out = [];
  let depth = 0, cur = "", i = open + 1, quote = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += s[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    }
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function auditActionsInSource() {
  const found = []; // { action, kind: "literal" | "template" | "variable", file }
  for (const path of files(SRC)) {
    const s = readFileSync(path, "utf8");
    const file = relative(SRC, path);
    for (const m of s.matchAll(CALL)) {
      const before = s.slice(Math.max(0, m.index - 9), m.index);
      if (/(async |function )$/.test(before)) continue; // a definition, not a call
      const raw = args(s, m.index + m[0].length - 1)[ACTION_ARG[m[1]]];
      if (!raw) continue;
      // A ternary's condition (`decision === "approve" ? ...`) isn't an action: only its branches are.
      const a = raw.replace(/[!=]==?\s*(["'])[^"']*\1/g, "");
      const literals = [...a.matchAll(/(["'])([a-z][a-z0-9_]*)\1/g)].map((x) => x[2]);
      const templates = [...a.matchAll(/`([^`]*)`/g)].map((x) => x[1]);
      for (const l of literals) found.push({ action: l, kind: "literal", file });
      for (const t of templates) found.push({ action: t, kind: t.includes("${") ? "template" : "literal", file });
      if (!literals.length && !templates.length) found.push({ action: `var:${a}`, kind: "variable", file });
    }
    for (const m of s.matchAll(/audit_log \([^)]*\) VALUES \(([^)]*)\)/g))
      for (const x of m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)) found.push({ action: x[1], kind: "literal", file });
  }
  return found;
}
