// Checks and applies Mynt's reference products' v2 definitions (schemas/examples/seed/*.v2.json) through admin
// tools. Shared by scripts/apply-seed-definitions.mjs (against a live server, over MCP) and its tests (an in-process
// server), so what the tests check is exactly what the script does.
//
// `call(name, input)` returns { isError, data }; `say` and `shout` print a line.

const stable = (v) =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// 1. Check every definition (check_product_definition with the product id). `ready` is whether all of them are
// valid with no publish blockers.
export async function checkSeedDefinitions({ call, defs, say = () => {}, shout = say }) {
  let ready = true;
  const results = [];
  for (const { file, def } of defs) {
    const r = await call("check_product_definition", { product_id: def._id, definition: def });
    const blockers = r.data.publish_blockers ?? [];
    const ok = !r.isError && Boolean(r.data.valid) && !blockers.length;
    results.push({ id: def._id, ready: ok, regulator: r.data.catalogue_record?.regulator, region: r.data.catalogue_record?.region, data: r.data });
    if (!ok) {
      ready = false;
      shout(`${def._id}: NOT READY (${file})`);
      if (r.data.error) shout(`  ${r.data.error}`);
      for (const e of r.data.errors ?? []) shout(`  error: ${e}`);
      for (const b of blockers) shout(`  publish blocker: ${b.key} (${b.primitive} ${b.action}, ${b.region}): ${b.reason}`);
    } else {
      const warnings = r.data.warnings ?? [];
      say(`${def._id}: valid, no publish blockers; catalogue cites ${r.data.catalogue_record?.regulator} in ${r.data.catalogue_record?.region}${warnings.length ? `; warnings: ${warnings.join("; ")}` : ""}`);
    }
  }
  return { ready, results };
}

// 2. Save, test and publish each; one whose live definition already matches the file is skipped.
export async function applySeedDefinitions({ call, defs, say = () => {} }) {
  for (const { def } of defs) {
    const current = await call("get_product_definition", { product_id: def._id });
    if (!current.isError && current.data.live_definition_hash && same(current.data.definition, def)) {
      say(`${def._id}: unchanged (live definition already matches), skipped`);
      continue;
    }
    const step = async (name, input) => {
      const r = await call(name, input);
      if (r.isError) throw new Error(`${def._id}: ${name} failed: ${JSON.stringify(r.data)}`);
      return r.data;
    };
    await step("set_product_definition", { product_id: def._id, definition: def, changelog: "v2 definition for Mynt's reference catalogue" });
    const tested = await step("test_product", { id: def._id });
    if (!tested.passed) throw new Error(`${def._id}: test_product failed: ${JSON.stringify(tested.checks.filter((c) => c.status === "fail"))}`);
    const live = await step("publish_product", { id: def._id });
    const contract = await call("get_developer_contract", { product_id: def._id });
    const c = contract.data;
    say(
      contract.isError
        ? `${def._id}: published version ${live.version ?? "?"}, but its contract couldn't be read: ${c.error}`
        : `${def._id}: published version ${c.version}; contract ${c.contract_hash} with ${c.offers.length} offer(s), ${c.actions.length} action(s)`,
    );
  }
}
