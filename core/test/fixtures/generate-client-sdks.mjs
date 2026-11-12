// Writes a generated SDK in every language for a defined product (the recurring deposit from the v2
// tests), so CI can compile the device SDKs with their own toolchains.
//   node test/fixtures/generate-client-sdks.mjs <out dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateSdk, SDK_LANGUAGES } from "../../dist/sdk.js";
import { publishDefined, setup } from "../v2-helpers.js";

export async function clientSdkFiles(baseUrl = "https://mynt.example.com") {
  const ctx = await setup();
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    d.partner_handoffs[0].sends = { type: "object", required: ["pan", "bank_account_number", "ifsc", "amount"] };
    return d;
  });
  const record = await ctx.store.getProduct("everyday-rd");
  const files = await generateSdk({ name: "Saver kit", version: "1.0.0", languages: [...SDK_LANGUAGES], baseUrl, products: [{ record, issuer: "Ines Bank" }] });
  return { ctx, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? "sdk-out";
  const { files } = await clientSdkFiles();
  for (const f of files) {
    mkdirSync(dirname(join(out, f.path)), { recursive: true });
    writeFileSync(join(out, f.path), f.content);
  }
  console.log(`${files.length} files in ${out}`);
  process.exit(0);
}
