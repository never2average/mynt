import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MYNT_REFUSALS_BEFORE_ANY_CHANGE } from "@/lib/studio-server";

// The studio treats these refusals as "Mynt changed nothing", so a message can be sent again.
// They must match how Mynt words them: if Mynt's wording changes, this fails rather than the
// studio silently keeping (or worse, releasing) claims.
const source = (path: string) => readFileSync(fileURLToPath(new URL(`../../../src/${path}`, import.meta.url)), "utf8");

describe("Mynt's refusal wording", () => {
  // Template placeholders (${...}) stand for a value, as in a real message.
  const mynt = [source("builds.ts"), source("server.ts")].join("\n").replace(/\$\{[^}]*\}/g, "value");

  for (const pattern of MYNT_REFUSALS_BEFORE_ANY_CHANGE) {
    it(`still has a message matching ${pattern}`, () => {
      expect(pattern.test(mynt)).toBe(true);
    });
  }
});
