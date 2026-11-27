// Writes the contract of a shipped standard service type (get_service_type_contract), so CI can scaffold a service
// from it and run the template's own tests against a real contract.
//   node test/fixtures/generate-service-contract.mjs <out file> [service type key, default identity_verification]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../dist/server.js";
import { Store } from "../../dist/store.js";
import { CATALOG } from "../helpers.js";

export async function serviceContract(key = "identity_verification") {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Root", ["admin"]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(s);
  const client = new Client({ name: "contract", version: "0" });
  await client.connect(c);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const data = JSON.parse(res.content[0].text);
    if (res.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
    return data;
  };
  // The shipped type as it is, without the licence types a fresh Mynt has no regulatory model for.
  const shipped = JSON.parse(readFileSync(new URL(`../../schemas/service-types/us/${key}.json`, import.meta.url), "utf8"));
  await call("define_service_type", { service_type: { ...shipped, innovator_licences: [], vendor_licences: [] } });
  return call("get_service_type_contract", { key, region: shipped.region });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? "service-contract.json";
  const contract = await serviceContract(process.argv[3]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(contract, null, 2) + "\n");
  console.log(`${contract.service_type.key} (${contract.service_type.region}) in ${out}`);
  process.exit(0);
}
