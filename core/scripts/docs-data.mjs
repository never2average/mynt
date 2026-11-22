// Writes the data behind Mynt Studio's docs (/docs) from the live tool registry and the repository's Markdown:
// docs/site/tools.json and pages.json (src/docs-site.ts). Run after changing a tool, a role or a
// doc the docs pages quote; test/tool-catalogue.test.js fails until the committed files match.
//
//   cd core && npm run build && npm run docs-data
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { docsSiteFiles } from "../dist/docs-site.js";
import { Store } from "../dist/store.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pg = new PGlite();
const store = await Store.open({ query: (sql, params) => pg.query(sql, params), exec: (sql) => pg.exec(sql), close: () => pg.close() }, []);
try {
  for (const [path, text] of Object.entries(await docsSiteFiles(store, root))) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    console.log(`wrote ${path}`);
  }
} finally {
  await pg.close();
}
