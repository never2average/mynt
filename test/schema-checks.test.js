import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// A database created before a value joined one of the lists keeps the old check on that column; opening the
// store must bring it up to date, or the new value is refused (as digital_assets was on production).
test("opening the store refreshes list checks an older database still has", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  await Store.open(db, CATALOG);
  // Simulate the older database: the underlying check without digital_assets, the line check without information.
  await pg.exec(`ALTER TABLE financial_products.regulated_product_types DROP CONSTRAINT regulated_product_types_underlying_check;
    ALTER TABLE financial_products.regulated_product_types ADD CONSTRAINT regulated_product_types_underlying_check
      CHECK (underlying IN ('cash','securities','commodities','real_assets','receivables','risk','data'));`);
  const insert = () =>
    pg.query(
      `INSERT INTO financial_products.regulated_product_types (region, id, name, type_id, actions, underlying)
       SELECT (SELECT code FROM financial_products.regions LIMIT 1), 'test_digital', 'Test',
              (SELECT id FROM financial_products.product_categories LIMIT 1), ARRAY['sale'], 'digital_assets'`,
    );
  await assert.rejects(insert, /underlying_check/, "the older check refuses the new value");
  await Store.open(db, CATALOG);
  await insert();
  const { rows } = await pg.query("SELECT underlying FROM financial_products.regulated_product_types WHERE id = 'test_digital'");
  assert.equal(rows[0].underlying, "digital_assets");
});
