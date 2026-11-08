// The Turnkey policy Mynt's docs give (docs/turnkey-solana-policy.json), evaluated against real transactions.
//
// A small interpreter for the part of Turnkey's policy language that policy uses, written from Turnkey's
// language reference (https://docs.turnkey.com/concepts/policies/language): ==, !=, &&, ||, !, `in` a list,
// list literals, strings, ints, field access, list indexing x[i], string slicing s[a..b] (end exclusive),
// and the list functions all, any, filter and count. As Turnkey documents, && and || don't short-circuit,
// and a condition that can't be evaluated (a missing field, an index out of range) doesn't allow.
//
// Turnkey's view of a Solana transaction (solana.tx.*) is built from the wire bytes the way its reference
// describes the fields: account_keys, program_keys, instructions (program_key, accounts with account_key,
// instruction_data_hex), transfers (system-program transfers only) and address_table_lookups.
import { readFileSync } from "node:fs";

const { base58Encode } = await import("../dist/solana/codec.js");

export const POLICY = JSON.parse(readFileSync(new URL("../docs/turnkey-solana-policy.json", import.meta.url), "utf8"));
export const SYSTEM = "11111111111111111111111111111111";

class PolicyError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new PolicyError("unterminated string");
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "&&", "||", ".."].includes(two)) {
      out.push({ t: two });
      i += 2;
      continue;
    }
    if ("()[],.!".includes(c)) {
      out.push({ t: c });
      i++;
      continue;
    }
    const num = /^\d+/.exec(src.slice(i));
    if (num) {
      out.push({ t: "int", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push(id[0] === "in" ? { t: "in" } : { t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new PolicyError(`unexpected '${c}'`);
  }
  return out;
}

function parse(src) {
  const toks = tokenize(src);
  let k = 0;
  const peek = (t) => toks[k]?.t === t;
  const eat = (t) => {
    if (!peek(t)) throw new PolicyError(`expected ${t} at token ${k}`);
    return toks[k++];
  };
  const or = () => {
    let l = and();
    while (peek("||")) (k++, (l = { op: "||", l, r: and() }));
    return l;
  };
  const and = () => {
    let l = not();
    while (peek("&&")) (k++, (l = { op: "&&", l, r: not() }));
    return l;
  };
  const not = () => (peek("!") ? (k++, { op: "!", e: not() }) : cmp());
  const cmp = () => {
    const l = postfix();
    for (const op of ["==", "!=", "in"]) if (peek(op)) return (k++, { op, l, r: postfix() });
    return l;
  };
  const postfix = () => {
    let e = primary();
    for (;;) {
      if (peek(".")) {
        k++;
        const name = eat("id").v;
        if (peek("(")) {
          k++;
          const args = [];
          while (!peek(")")) {
            args.push(or());
            if (peek(",")) k++;
          }
          eat(")");
          e = { op: "call", target: e, name, args };
        } else e = { op: "field", target: e, name };
      } else if (peek("[")) {
        k++;
        const a = or();
        if (peek("..")) {
          k++;
          const b = or();
          eat("]");
          e = { op: "slice", target: e, a, b };
        } else {
          eat("]");
          e = { op: "index", target: e, a };
        }
      } else return e;
    }
  };
  const primary = () => {
    if (peek("str")) return { op: "lit", v: toks[k++].v };
    if (peek("int")) return { op: "lit", v: toks[k++].v };
    if (peek("id")) return { op: "var", name: toks[k++].v };
    if (peek("(")) {
      k++;
      const e = or();
      eat(")");
      return e;
    }
    if (peek("[")) {
      k++;
      const items = [];
      while (!peek("]")) {
        items.push(or());
        if (peek(",")) k++;
      }
      eat("]");
      return { op: "list", items };
    }
    throw new PolicyError(`unexpected token ${toks[k]?.t} at ${k}`);
  };
  const e = or();
  if (k !== toks.length) throw new PolicyError(`trailing tokens at ${k}`);
  return e;
}

function evaluate(e, env) {
  const ev = (x, en = env) => evaluate(x, en);
  const bool = (v) => {
    if (typeof v !== "boolean") throw new PolicyError("not a boolean");
    return v;
  };
  switch (e.op) {
    case "lit":
      return e.v;
    case "list":
      return e.items.map((x) => ev(x));
    case "var":
      if (!(e.name in env)) throw new PolicyError(`unknown ${e.name}`);
      return env[e.name];
    case "field": {
      const t = ev(e.target);
      if (t === null || typeof t !== "object" || !(e.name in t)) throw new PolicyError(`no field ${e.name}`);
      return t[e.name];
    }
    case "index": {
      const t = ev(e.target);
      const i = ev(e.a);
      if (!Array.isArray(t) && typeof t !== "string") throw new PolicyError("not indexable");
      if (!Number.isInteger(i) || i < 0 || i >= t.length) throw new PolicyError("index out of range");
      return t[i];
    }
    case "slice": {
      const t = ev(e.target);
      const a = ev(e.a);
      const b = ev(e.b);
      if (!Array.isArray(t) && typeof t !== "string") throw new PolicyError("not sliceable");
      if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= b && b <= t.length)) throw new PolicyError("slice out of range");
      return t.slice(a, b);
    }
    case "call": {
      const t = ev(e.target);
      if (!Array.isArray(t)) throw new PolicyError(`${e.name} on a non-list`);
      if (e.name === "count") return t.length;
      if (e.name === "contains") return t.includes(ev(e.args[0]));
      const [bind, pred] = e.args;
      if (bind?.op !== "var") throw new PolicyError(`${e.name} needs a variable`);
      // Every element is evaluated: an error anywhere is an error.
      const results = t.map((x) => ({ x, ok: bool(ev(pred, { ...env, [bind.name]: x })) }));
      if (e.name === "all") return results.every((r) => r.ok);
      if (e.name === "any") return results.some((r) => r.ok);
      if (e.name === "filter") return results.filter((r) => r.ok).map((r) => r.x);
      throw new PolicyError(`unknown function ${e.name}`);
    }
    case "!":
      return !bool(ev(e.e));
    case "&&": {
      const l = bool(ev(e.l));
      const r = bool(ev(e.r)); // no short-circuit
      return l && r;
    }
    case "||": {
      const l = bool(ev(e.l));
      const r = bool(ev(e.r));
      return l || r;
    }
    case "==":
      return ev(e.l) === ev(e.r);
    case "!=":
      return ev(e.l) !== ev(e.r);
    case "in": {
      const l = ev(e.l);
      const r = ev(e.r);
      if (!Array.isArray(r)) throw new PolicyError("in needs a list");
      return r.includes(l);
    }
  }
  throw new PolicyError(`unknown op ${e.op}`);
}

function readShortVec(b, o) {
  let n = 0;
  for (let shift = 0; ; shift += 7) {
    const x = b[o++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, o];
  }
}

// Turnkey's solana.tx view of an unsigned (or signed) legacy wire transaction.
export function solanaTxView(wire) {
  const [nsig, o] = readShortVec(wire, 0);
  const m = wire.subarray(o + 64 * nsig);
  const [nkeys, p0] = readShortVec(m, 3);
  let p = p0;
  const keys = [];
  for (let i = 0; i < nkeys; i++, p += 32) keys.push(base58Encode(m.subarray(p, p + 32)));
  p += 32;
  const [nix, p1] = readShortVec(m, p);
  p = p1;
  const instructions = [];
  const transfers = [];
  for (let i = 0; i < nix; i++) {
    const program_key = keys[m[p++]];
    let na;
    [na, p] = readShortVec(m, p);
    const accounts = [...m.subarray(p, p + na)].map((x) => ({ account_key: keys[x], signer: x < m[0], writable: true }));
    p += na;
    let nd;
    [nd, p] = readShortVec(m, p);
    const data = Buffer.from(m.subarray(p, p + nd));
    p += nd;
    instructions.push({ program_key, accounts, instruction_data_hex: data.toString("hex"), address_table_lookups: [] });
    if (program_key === SYSTEM && data.length >= 12 && data.readUInt32LE(0) === 2)
      transfers.push({ from: accounts[0].account_key, to: accounts[1].account_key, amount: Number(data.readBigUInt64LE(4)) });
  }
  return {
    account_keys: keys,
    program_keys: [...new Set(instructions.map((i) => i.program_key))],
    instructions,
    transfers,
    spl_transfers: [],
    address_table_lookups: [],
    recent_blockhash: base58Encode(m.subarray(p0 + 32 * nkeys, p0 + 32 * nkeys + 32)),
    version: "LEGACY",
  };
}

// Whether the policy allows Turnkey to sign `wire` with `custody`. An evaluation error doesn't allow.
export function policyAllows(wire, custody, { condition = POLICY.condition, activityType = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", signWith = custody } = {}) {
  const ast = parse(condition.replaceAll("<custody address>", custody));
  const env = {
    activity: { type: activityType, params: { type: "TRANSACTION_TYPE_SOLANA" } },
    wallet_account: { address: signWith },
    solana: { tx: solanaTxView(wire) },
  };
  try {
    return evaluate(ast, env) === true;
  } catch (e) {
    if (e instanceof PolicyError) return false;
    throw e;
  }
}

export { parse as parsePolicy };
