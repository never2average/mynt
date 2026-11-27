// Runs Mynt's own conformance cases (the ones run_conformance runs) against a scaffolded service running locally,
// the way Mynt calls a hosted one: POST <address>/mynt/services/<key>, signed, with no key and no credential.
//   MYNT_VENDOR_SIGNING_SECRET=<the service's> node test/fixtures/service-conformance.mjs <http://127.0.0.1:port> <contract.json>
import { readFileSync } from "node:fs";
import { callVendor } from "../../dist/vendor-call.js";
import { conformanceCases } from "../../dist/vendors.js";

const [origin, contractPath] = process.argv.slice(2);
const secret = process.env.MYNT_VENDOR_SIGNING_SECRET;
if (!origin || !contractPath || !secret) {
  console.error("usage: MYNT_VENDOR_SIGNING_SECRET=… node test/fixtures/service-conformance.mjs <origin> <contract.json>");
  process.exit(2);
}
const c = JSON.parse(readFileSync(contractPath, "utf8"));
// The service type, as far as the cases read it.
const type = {
  key: c.service_type.key,
  region: c.service_type.region,
  name: c.service_type.name,
  consent_purpose: c.service_type.consent_purpose,
  input_schema: c.request.input_schema,
  output_schema: c.response.output_schema,
  params_schema: c.request.params_schema ?? null,
  params_fixture: c.fixtures[0]?.params ?? null,
  accepts: c.service_type.accepts ?? null,
  quote: c.service_type.quote ?? false,
  fixtures: c.fixtures.map((f) => f.input),
};
const url = `${origin.replace(/\/+$/, "")}${c.endpoint.app_path}`;
const cases = await conformanceCases(type, secret, (_name, body, signature) =>
  callVendor({ base_url: url, service_type: type.key, body, signing_secret: secret, signature, exact_url: true }, { allowInsecureLoopback: true, timeoutMs: 5000 }),
);
for (const k of cases) console.log(`${k.passed ? "pass" : "FAIL"} ${k.case}${k.problems.length ? `: ${k.problems.join("; ")}` : ""}`);
process.exit(cases.every((k) => k.passed) ? 0 : 1);
