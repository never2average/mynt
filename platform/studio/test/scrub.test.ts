import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIDDEN, MYNT_TOKEN_KINDS, SECRET_PREFIXES, scrub, scrubStream, scrubText } from "@/lib/scrub";

// Ask AI's scrub (lib/scrub.ts) keeps its own copy of the secret shapes Mynt's server scrubs from what its agents
// print (core/src/boxes.ts): the studio doesn't import the server. These read the server's file, so a shape added
// there and not here fails. Every value below is an obvious fake.
const boxes = readFileSync(fileURLToPath(new URL("../../../core/src/boxes.ts", import.meta.url)), "utf8");
const TAIL = "FAKEfakeFAKEfakeFAKEfake00000001";

describe("the secret shapes are the server's", () => {
  it("knows every kind of Mynt key and token the server does", () => {
    const kinds = /const MYNT_TOKEN_KINDS = \[([^\]]+)\]/.exec(boxes);
    expect(kinds, "core/src/boxes.ts still declares MYNT_TOKEN_KINDS").not.toBeNull();
    const server = [...kinds![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(server.length).toBeGreaterThan(2);
    expect([...MYNT_TOKEN_KINDS].sort()).toEqual([...server].sort());
  });

  it("knows every prefix the server follows directly with a secret", () => {
    // In the server's patterns: \b<prefix> followed at once by the character class of the secret itself.
    const server = new Set([...boxes.matchAll(/\\b([a-z][a-z0-9_-]*[_-])\[A-Za-z0-9/g)].map((m) => m[1]));
    expect(server.size).toBeGreaterThan(4);
    for (const mynt of ["whsec_", "mvs_", "mpl_", "fpm_"]) expect(server.has(mynt), `the server scrubs ${mynt}`).toBe(true);
    expect([...SECRET_PREFIXES].sort()).toEqual([...server].sort());
  });

  it("hides one of each, wherever it sits", () => {
    const samples = [
      ...MYNT_TOKEN_KINDS.map((k) => `mynt_${k}_${TAIL}`),
      ...SECRET_PREFIXES.map((p) => `${p}${TAIL}${p === "npm_" ? "0000" : ""}`), // a registry token is 36 characters
      `mcs_live_${TAIL}`,
      `mcs_test_${TAIL}`,
      `sk_live_${TAIL}`,
      `sk_test_${TAIL}`,
      `rk_live_${TAIL}`,
      `ghp_${TAIL}`,
      `xoxb-${TAIL}`,
      `AKIA${"A".repeat(16)}`,
    ];
    for (const s of samples) {
      expect(scrubText(`the value ${s} was set`), s).toBe(`the value ${HIDDEN} was set`);
      expect(JSON.stringify(scrub({ note: [`see ${s}`], rows: [{ detail: s }] })), s).not.toContain(TAIL);
    }
  });

  it("leaves ordinary words alone, tool names and ids included", () => {
    for (const s of ["list_my_apps returned 3 apps", "npm_config_registry is unset", "the mynt_live key is set", "risk-based pricing, sk-1", "app 2f6c1b1e-0a1c-4a57-9c39-3f6d1e0a7b11 is in staging", "-----BEGIN PRIVATE KEY----- is how a key starts"])
      expect(scrubText(s)).toBe(s);
  });

  it("hides a private key, whole or cut off", () => {
    expect(scrubText("key:\n-----BEGIN EC PRIVATE KEY-----\nMIIfake\nfake==\n-----END EC PRIVATE KEY-----\nend")).toBe(`key:\n${HIDDEN}\nend`);
    expect(scrubText("key:\n-----BEGIN PRIVATE KEY-----\nMIIfakefakefake")).toBe(`key:\n${HIDDEN}`);
  });
});

describe("scrubbing text as it's written", () => {
  const through = (pieces: string[]) => {
    const out: string[] = [];
    const s = scrubStream((t) => out.push(t));
    for (const p of pieces) s.push(p);
    s.flush();
    return out;
  };

  it("passes ordinary text on as it arrives, piece for piece", () => {
    expect(through(["You have ", "one app, ", "Round-up ", "savings."])).toEqual(["You have ", "one app, ", "Round-up ", "savings."]);
  });

  it("catches a secret split across pieces, however it's cut", () => {
    const secret = `whsec_${TAIL}`;
    for (let cut = 1; cut < secret.length; cut++) {
      const text = through(["The secret is ", secret.slice(0, cut), secret.slice(cut), " and that's all."]).join("");
      expect(text, `cut at ${cut}`).toBe(`The secret is ${HIDDEN} and that's all.`);
    }
    // One character at a time.
    expect(through([...`key mynt_agent_${TAIL} end`]).join("")).toBe(`key ${HIDDEN} end`);
  });

  it("holds back what spans white space until it's whole: a bearer token, a private key", () => {
    expect(through(["Send Authorization: Bearer ", "abcdefghijklmnop.qrstuv", " to the API."]).join("")).toBe(`Send Authorization: ${HIDDEN} to the API.`);
    const pem = ["Here: -----BEGIN PRIVATE KEY-----\n", "MIIfakefake\n", "fakefake==\n", "-----END PRIVATE KEY-----", " done."];
    const out = through(pem);
    expect(out.join("")).toBe(`Here: ${HIDDEN} done.`);
    expect(out.join("")).not.toContain("MIIfake");
    // Cut off before its END line: still never shown.
    expect(through(pem.slice(0, 3)).join("")).toBe(`Here: ${HIDDEN}`);
  });

  it("starts again after a reset: what was dropped is never passed on", () => {
    const out: string[] = [];
    const s = scrubStream((t) => out.push(t));
    s.push("Let me look whsec_FAKE");
    s.reset();
    s.push("You have one app.");
    s.flush();
    expect(out.join("")).toBe("Let me look You have one app.");
  });
});
