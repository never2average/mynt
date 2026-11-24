// Copies core's built shared modules (core/src/confidential/shared/*.ts, built to core/dist/confidential/shared/) into
// src/shared/, so the image computes product health with exactly the code Mynt's server runs. Run after
// `cd core && npm run build`; core/test/confidential.test.js fails while the copies differ.
import { copyFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../core/dist/confidential/shared/", import.meta.url));
const to = fileURLToPath(new URL("../src/shared/", import.meta.url));
for (const f of readdirSync(from).filter((f) => f.endsWith(".js"))) {
  copyFileSync(from + f, to + f);
  console.log(`src/shared/${f}`);
}
