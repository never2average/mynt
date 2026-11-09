import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");

const { BuildService, buildConfigFromEnv } = await import("../dist/builds.js");
const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { SolanaService } = await import("../dist/solana/service.js");
const { executableHash, base58Decode } = await import("../dist/solana/codec.js");
const { MainnetGateService, gateConfigFromEnv, assessStatic, assessAudit } = await import("../dist/solana/mainnet-gate.js");
const { loadVulnDb, entryProblems, dbProblems, suggestFromAdvisories, VULN_CATEGORIES } = await import("../dist/solana/vuln-db.js");
const { runDetections } = await import("../dist/solana/program-rules.js");
const { checkProgramRules, stripComments, TOKEN_PROGRAM, upgradeAuthorityRule } = await import("../dist/solana/program-rules.js");
const { GATE_ANALYSIS_SCRIPT, GATE_CONFIRM_SCRIPT, GATE_TOOLS } = await import("../dist/solana/gate-scripts.js");
const { workspaceFiles, AGENT_DIR, workspaceCwd } = await import("../dist/agent-host.js");
const { CATALOG } = await import("./helpers.js");

const ID = "HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw";
const sourcesOf = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (!["target", "node_modules"].includes(name) && !name.startsWith(".")) walk(p);
      } else if (name.endsWith(".rs") || ["Cargo.toml", "Anchor.toml", "Cargo.lock"].includes(name)) out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
};
const TEMPLATE = sourcesOf(new URL("../workspaces/coding-build/templates/solana-program", import.meta.url).pathname);
const fixture = (name) => sourcesOf(new URL(`./fixtures/solana-programs/${name}`, import.meta.url).pathname);
const elf = (size = 4000, extra = null) => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size - 64; i++) b[i] = (i * 31 + 7) % 251 || 1;
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(b);
  if (extra) Buffer.from(extra).copy(b, 1000);
  return new Uint8Array(b);
};
const rules = (sources, extra = {}) => checkProgramRules({ name: "p", program_id: ID, program: elf(), idl: null, sources, ...extra });
const blocking = (r) => r.findings.filter((f) => f.blocks);

// ---- the hard rules ----

test("hard rules: the template ledger passes; a token vault, a hard-coded admin and a lamport-draining close are refused, each saying what was found", () => {
  const ok = rules(TEMPLATE);
  assert.equal(ok.passed, true, JSON.stringify(blocking(ok)));
  assert.deepEqual(ok.signals, { source: true, idl: false, bytes: true });
  assert.ok(ok.limits.some((l) => /pattern-based/.test(l)) && ok.limits.some((l) => /Not available.*idl/.test(l)), "the limits are stated");

  const token = rules(fixture("token_vault"));
  assert.equal(token.passed, false);
  assert.ok(blocking(token).some((f) => f.rule === "RUG-TOKEN-CPI" && /anchor_spl::token/.test(f.detail) && f.file === "programs/token_vault/src/lib.rs" && f.line === 2));
  assert.ok(blocking(token).some((f) => /token program's transfer/.test(f.detail)));

  const admin = rules(fixture("hidden_admin"));
  assert.equal(admin.passed, false);
  assert.ok(blocking(admin).some((f) => f.rule === "RUG-HARDCODED-ADMIN" && /require_keys_eq! authorizes against a hard-coded key, ADMIN \(9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM/.test(f.detail)));
  assert.ok(blocking(admin).some((f) => /set_authority sets .*authority to new_authority, an argument anyone can choose/.test(f.detail)));

  const drain = rules(fixture("lamport_drain"));
  assert.equal(drain.passed, false);
  assert.ok(blocking(drain).some((f) => f.rule === "RUG-CLOSE-NON-SIGNER" && /closes ledger and sends its lamports to receiver, which isn't a signer/.test(f.detail)));
});

test("hard rules: system transfers signed by the program, hand-moved lamports, pinned admins and their comparisons are refused; comments can't hide or fake them", () => {
  const lib = (body) => ({ "programs/p/src/lib.rs": `use anchor_lang::prelude::*;\ndeclare_id!("${ID}");\n${body}` });
  const signedTransfer = rules(lib(`pub fn sweep(ctx: Context<Sweep>) -> Result<()> {\n  invoke_signed(&system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.to.key(), 5), &[], &[&[b"v", &[1]]])?;\n  Ok(())\n}`));
  assert.ok(blocking(signedTransfer).some((f) => f.rule === "RUG-SYSTEM-TRANSFER" && /system_instruction::transfer: a system-program transfer/.test(f.detail)));
  const cpiTransfer = rules(lib(`pub fn pay(ctx: Context<Pay>) -> Result<()> {\n  system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), system_program::Transfer { from: a, to: b }), 1)\n}`));
  assert.ok(blocking(cpiTransfer).some((f) => f.rule === "RUG-SYSTEM-TRANSFER"));
  const assign = rules(lib(`fn x() { let ix = system_instruction::assign(&k, &o); }`));
  assert.ok(blocking(assign).some((f) => /assign/.test(f.detail)));
  const lamports = rules(lib(`pub fn drain(ctx: Context<D>) -> Result<()> {\n  ctx.accounts.vault.sub_lamports(10)?;\n  **ctx.accounts.to.lamports.borrow_mut() += 10;\n  Ok(())\n}`));
  assert.equal(blocking(lamports).filter((f) => /moves lamports directly/.test(f.detail)).length, 2);
  const pinned = rules(
    lib(`const OWNER: Pubkey = pubkey!("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");\n#[derive(Accounts)]\npub struct Admin<'info> {\n  #[account(address = OWNER)]\n  pub admin: Signer<'info>,\n}\npub fn go(ctx: Context<Admin>) -> Result<()> {\n  if ctx.accounts.admin.key() != OWNER { return err!(E::No); }\n  Ok(())\n}`),
  );
  assert.ok(blocking(pinned).some((f) => /Admin\.admin's address constraint authorizes against a hard-coded key, OWNER/.test(f.detail)));
  assert.ok(blocking(pinned).some((f) => /go's comparison/.test(f.detail)));
  // The key's 32 bytes in the program corroborate the source.
  const withBytes = checkProgramRules({ name: "p", program_id: ID, program: elf(4000, base58Decode("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")), idl: null, sources: pinned.findings.length ? lib(`const OWNER: Pubkey = pubkey!("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");\npub fn go(ctx: Context<A>) -> Result<()> { require_keys_eq!(ctx.accounts.a.key(), OWNER); Ok(()) }`) : {} });
  assert.ok(withBytes.findings.some((f) => f.signal === "bytes" && /9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM/.test(f.detail)));
  // Mynt's own signer as the pinned key is allowed (noted, not blocking).
  const mynt = rules(lib(`const OWNER: Pubkey = pubkey!("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");\npub fn go(ctx: Context<A>) -> Result<()> { require_keys_eq!(ctx.accounts.a.key(), OWNER); Ok(()) }`), { mynt_signer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" });
  assert.equal(mynt.passed, true);
  assert.ok(mynt.findings.some((f) => !f.blocks && /Mynt's own mainnet signer/.test(f.detail)));
  // Comments neither hide code nor create findings.
  assert.equal(rules(lib(`// token::transfer(cpi, 1) and system_instruction::transfer(a, b, 1)\n/* anchor_spl::token */\nfn ok() {}`)).passed, true);
  assert.equal(stripComments('let s = "// not a comment"; // gone').trim(), 'let s = "// not a comment";');
  // Authority handed to a signer, a let-bound signer key, or renounced: fine.
  const handover = rules(
    lib(`#[derive(Accounts)]\npub struct Move<'info> {\n  #[account(mut, has_one = authority)]\n  pub ledger: Account<'info, Ledger>,\n  pub authority: Signer<'info>,\n  pub new_authority: Signer<'info>,\n}\npub fn mv(ctx: Context<Move>) -> Result<()> {\n  let next = ctx.accounts.new_authority.key();\n  ctx.accounts.ledger.authority = next;\n  Ok(())\n}\npub fn renounce(ctx: Context<Move>) -> Result<()> { ctx.accounts.ledger.authority = Pubkey::default(); Ok(()) }`),
  );
  assert.equal(handover.passed, true, JSON.stringify(blocking(handover)));
  // Without the source the rules can't run in full: refused.
  const noSource = checkProgramRules({ name: "p", program_id: ID, program: elf(), idl: null, sources: null });
  assert.equal(noSource.passed, false);
  assert.match(blocking(noSource)[0].detail, /no captured source/);
});

test("hard rules: the IDL and the bytes are signals of their own", () => {
  const idl = {
    instructions: [
      { name: "withdraw", accounts: [{ name: "vault", writable: true }, { name: "token_program", address: TOKEN_PROGRAM }] },
      { name: "admin_reset", accounts: [{ name: "admin", signer: true, address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, { name: "system_program", address: "11111111111111111111111111111111" }] },
    ],
  };
  const r = checkProgramRules({ name: "p", program_id: ID, program: elf(), idl, sources: TEMPLATE });
  assert.ok(r.findings.some((f) => f.signal === "idl" && f.rule === "RUG-TOKEN-CPI" && /SPL Token program/.test(f.detail)));
  assert.ok(r.findings.some((f) => f.signal === "idl" && f.rule === "RUG-HARDCODED-ADMIN" && f.blocks && /admin_reset requires admin to be the fixed key/.test(f.detail)));
  assert.ok(!r.findings.some((f) => /system_program/.test(f.detail)), "well-known programs aren't admins");
  // The token program's id in the bytes, raw or as text, even when the source doesn't show it.
  for (const extra of [base58Decode(TOKEN_PROGRAM), Buffer.from(TOKEN_PROGRAM)]) {
    const b = checkProgramRules({ name: "p", program_id: ID, program: elf(4000, extra), idl: null, sources: TEMPLATE });
    assert.equal(b.passed, false);
    assert.ok(b.findings.some((f) => f.signal === "bytes" && /SPL Token program's id/.test(f.detail)));
  }
});

test("hard rules: the upgrade authority must stay Mynt's own mainnet signer", () => {
  assert.equal(upgradeAuthorityRule({ action: "deploy", signer: null, recorded_authority: null }).status, "pending");
  assert.equal(upgradeAuthorityRule({ action: "deploy", signer: { backend: "multisig", address: "A" }, recorded_authority: null }).blocks, true);
  assert.equal(upgradeAuthorityRule({ action: "upgrade", signer: { backend: "mainnet-vault", address: "A" }, recorded_authority: "B" }).blocks, true);
  assert.equal(upgradeAuthorityRule({ action: "upgrade", signer: { backend: "custody-service", address: "A" }, recorded_authority: "A" }).status, "pass");
});

test("static analysis: a tool that didn't run blocks, as does a sure critical or high finding; low-certainty highs are leads", () => {
  const ran = (name, findings = []) => ({ name, version: "1", status: "ran", detail: "", findings });
  assert.equal(assessStatic({ tools: [ran("cargo-audit"), ran("radar")] }).passed, true);
  assert.match(assessStatic({ tools: [ran("cargo-audit")] }).reasons[0], /radar didn't report/);
  assert.match(assessStatic({ tools: [ran("cargo-audit"), { ...ran("radar"), status: "error", detail: "no docker" }] }).reasons[0], /radar couldn't run: no docker/);
  assert.equal(assessStatic({ tools: [ran("cargo-audit", [{ severity: "high", title: "RUSTSEC-2099-0001", location: "x 1.0" }]), ran("radar")] }).passed, false);
  assert.equal(assessStatic({ tools: [ran("cargo-audit"), ran("radar", [{ severity: "high", certainty: "low", title: "Arbitrary CPI", location: "lib.rs:3" }])] }).passed, true);
  assert.equal(assessStatic({ tools: [ran("cargo-audit"), ran("radar", [{ severity: "critical", certainty: "medium", title: "X", location: "lib.rs:3" }])] }).passed, false);
  // The scripts pin what they run, and strip Radar's suppression comments from the copy they scan.
  assert.ok(GATE_ANALYSIS_SCRIPT.includes(GATE_TOOLS.cargoAudit.sha256) && GATE_ANALYSIS_SCRIPT.includes(GATE_TOOLS.radar.sha256));
  for (const digest of Object.values(GATE_TOOLS.radar.images)) assert.match(digest, /@sha256:[0-9a-f]{64}$/);
  assert.match(GATE_ANALYSIS_SCRIPT, /s\/radar-disable\/mynt-removed\/g/);
  assert.match(GATE_CONFIRM_SCRIPT, /signed by the victim/);
});

test("audit findings count only with a quote Mynt finds in the source", () => {
  const raw = JSON.stringify({
    findings: [
      { id: "A1", severity: "high", title: "Missing check", file: "programs/mynt_program/src/lib.rs", line: 22, quote: "ledger.count = ledger.count.checked_add(1)", description: "d" },
      { id: "A2", severity: "critical", title: "Invented", file: "programs/mynt_program/src/lib.rs", line: 1, quote: "fn steal_everything()", description: "d" },
      { id: "A3", severity: "high", title: "Wrong file", file: "nope.rs", quote: "anything at all here", description: "d" },
    ],
    summary: "s",
  });
  const a = assessAudit(raw, TEMPLATE);
  assert.equal(a.finished, true);
  assert.deepEqual(a.findings.map((f) => f.verified), [true, false, false]);
  assert.deepEqual(a.blocking.map((f) => f.id), ["A1"]);
  assert.equal(assessAudit("not json", TEMPLATE).finished, false);
});

// ---- the review: a world with fake sandboxes and fake agents ----

class FakeBoat {
  constructor(script) {
    this.script = script;
    this.sandboxes = new Map();
    this.stopped = [];
    this.n = 0;
  }
  async createSandbox({ name }) {
    const id = `sb${++this.n}`;
    this.sandboxes.set(id, { name, files: new Map() });
    return { id, state: "provisioning" };
  }
  async getSandbox(id) {
    return { id, state: "ready" };
  }
  async writeFile(id, path, content) {
    this.sandboxes.get(id).files.set(path, content);
  }
  async writeFiles(id, files) {
    for (const [p, c] of Object.entries(files)) await this.writeFile(id, p, c);
  }
  async readFile(id, path) {
    return this.sandboxes.get(id).files.get(path) ?? null;
  }
  async costDollars() {
    return 0.1;
  }
  async stop(id) {
    this.stopped.push(id);
  }
  async commandStatus() {
    return { running: false, exitCode: 0 };
  }
  async host() {
    return { url: "https://x" };
  }
  async downloadUrl() {
    return "https://x";
  }
  async exec(id, command) {
    const sb = this.sandboxes.get(id);
    const files = sb.files;
    const role = sb.name.replace(/^mynt-|-[0-9a-f-]{36}$/g, "");
    const put = (p, v) => files.set(p, typeof v === "string" ? v : JSON.stringify(v));
    if (command.includes("analysis.sh")) {
      sb.analysisArgs = command;
      put("/home/user/mynt-gate/out/static.json", this.script.static ?? { tools: [{ name: "cargo-audit", version: "0.22.2", status: "ran", detail: "", findings: [] }, { name: "radar", version: "3439053", status: "ran", detail: "", findings: [] }] });
      return { processId: 11, exitCode: null, stdout: "", stderr: "" };
    }
    if (command.includes("runner.mjs")) {
      const auth = JSON.parse(files.get(`${AGENT_DIR}/auth.json`));
      (this.tokens ??= {})[role] = auth.token;
      const done = (ok = true) => put(`${AGENT_DIR}/state.json`, { done: true, last_subtype: ok ? "success" : "error_max_budget_usd", cost_usd: 1.5, summary: "done" });
      if (role === "program-analysis") {
        sb.auditJob = JSON.parse(files.get(`${workspaceCwd("program-audit")}/job/review.json`));
        if (this.script.audit !== null) put(`${workspaceCwd("program-audit")}/job/findings.json`, this.script.audit ?? { findings: [], summary: "nothing found" });
        done(this.script.auditOk ?? true);
      } else {
        sb.redJob = JSON.parse(files.get(`${workspaceCwd("program-red-team")}/job/target.json`));
        const job = `${workspaceCwd("program-red-team")}/job`;
        put(`${job}/report.json`, this.script.redTeam ?? { findings: [], attacks_tried: ["wrong signer: rejected"], summary: "held up" });
        for (const [path, text] of Object.entries(this.script.pocFiles ?? {})) put(`${job}/poc/${path}`, text);
        done();
      }
      return { processId: 22, exitCode: null, stdout: "", stderr: "" };
    }
    if (command.includes("find . -path ./node_modules")) {
      const dir = /cd (\S+) /.exec(command)[1];
      const listed = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => `./${p.slice(dir.length + 1)}`);
      return listed.length ? { exitCode: 0, stdout: listed.join("\n"), stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (command.includes("confirm.py")) {
      sb.confirmJob = JSON.parse(files.get("/home/user/mynt-confirm/job.json"));
      put("/home/user/mynt-confirm/results.json", this.script.confirm ?? { results: {} });
      return { processId: 33, exitCode: null, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "", processId: 44 };
  }
}

async function world(script = {}, configEnv = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const builds = await BuildService.open(db, store, null, null, buildConfigFromEnv({}));
  const solana = await SolanaService.open(db, store, { rpcUrls: { devnet: "https://api.devnet.solana.com", mainnet: null }, mainnetVaultAllowed: false, confirmTimeoutMs: 1000, pollMs: 0 }, { rpc: () => ({ call: async () => { throw new Error("no RPC in these tests"); } }), custody: null });
  builds.solana = solana;
  const boat = new FakeBoat(script);
  const gate = await MainnetGateService.open(db, store, solana, boat, gateConfigFromEnv({ agentBackend: { kind: "anthropic", apiKey: "test" }, model: "claude-opus-5-5", publicUrl: "https://mynt.example" }, configEnv));
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds, solana, gate }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  const ok = async (client, name, args) => {
    const r = await call(client, name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const { user: otherUser } = await store.createUser("Other", ["developer"]);
  const entity = await store.createEntity(devUser.id, { name: "Dev Ltd", registration_numbers: {}, regions: ["US"] });
  await store.setUserEntity(devUser.id, entity.id);
  devUser.entity_id = entity.id;
  await store.createFirmWebhook(devUser.id, { entity_id: entity.id, url: "https://hooks.example.com/mynt", events: ["program.upgrade_scheduled", "program.upgrade_cancelled", "program.review_flagged"] });
  const app = await store.createApp(devUser.id, { name: "Ledger", description: "A ledger", audience: "Firms", product_ids: [] });
  const admin = await connect(adminUser);
  const dev = await connect(devUser);
  const other = await connect(otherUser);
  // A succeeded build whose verification built `sources` into a program declaring `programId`.
  const build = async (programId, sources = TEMPLATE, seed = 1) => {
    const b = await builds.start(devUser, { goal: "Build the ledger program", app_id: app.id });
    await db.query("UPDATE financial_products.build_runs SET status = 'succeeded' WHERE id = $1", [b.id]);
    const program = elf(4000 + seed);
    const text = JSON.stringify({ files: sources });
    await solana.recordArtifacts(b.id, [
      { name: "mynt_program", declared_id: programId, sha256: executableHash(program), size: program.length, program, idl: { instructions: [] }, sources: { sha256: createHash("sha256").update(text).digest("hex"), files: sources } },
    ]);
    return { build_id: b.id, sha256: executableHash(program) };
  };
  const mainnetProgram = async () => (await ok(dev, "reserve_program_id", { name: "mynt_program", cluster: "mainnet", app_id: app.id })).program_id;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) await gate.tick();
  };
  const review = async (id) => ok(dev, "get_mainnet_review", { review_id: id });
  const deliveries = async (type) => (await db.query("SELECT payload FROM financial_products.webhook_deliveries WHERE type = $1 ORDER BY created_at", [type])).rows.map((r) => r.payload);
  return { db, store, builds, solana, gate, boat, admin, dev, other, adminUser, devUser, ok, call, build, mainnetProgram, tick, review, deliveries };
}

test("a first mainnet deploy: hard rules, static analysis, audit, red team, then an admin; deploy_program is refused until exactly that hash is approved", async () => {
  const w = await world({
    audit: {
      findings: [
        { id: "A1", severity: "medium", title: "No upper bound on count", file: "programs/mynt_program/src/lib.rs", line: 22, quote: "ledger.count.checked_add(1)", description: "d", recommendation: "r" },
        { id: "A2", severity: "critical", title: "Made up", file: "programs/mynt_program/src/lib.rs", line: 1, quote: "fn drain_the_vault()", description: "d" },
      ],
      summary: "checked everything",
    },
    redTeam: {
      findings: [
        { id: "R1", title: "Takeover via substitution", severity: "critical", category: "authority_takeover", description: "d", poc: "R1" },
        { id: "R2", title: "A hunch", severity: "high", category: "pda_spoofing", description: "no proof" },
      ],
      attacks_tried: ["wrong signer: rejected"],
      summary: "s",
    },
    pocFiles: { "R1/run.sh": "#!/bin/bash\necho attack\n", "R1/attack.mjs": "console.log(1)" },
    confirm: { results: { R1: { confirmed: false, reason: "transaction 5x failed: ConstraintHasOne" } } },
  });
  const programId = await w.mainnetProgram();
  const { build_id, sha256 } = await w.build(programId);

  // Without a review, mainnet deploys are refused before anything else.
  let r = await w.call(w.dev, "deploy_program", { program_id: programId, build_id });
  assert.ok(r.isError);
  assert.match(r.data.error, /need an approved mainnet review of exactly this build's program/);

  // Devnet has no gate.
  const devnetId = (await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" })).program_id;
  assert.match((await w.call(w.dev, "request_mainnet_review", { program_id: devnetId, build_id })).data.error, /Only mainnet programs/);
  // Someone else's program isn't theirs to review.
  assert.match((await w.call(w.other, "request_mainnet_review", { program_id: programId, build_id })).data.error, /No program of yours/);

  const started = await w.ok(w.dev, "request_mainnet_review", { program_id: programId, build_id });
  assert.equal(started.status, "running");
  assert.equal(started.action, "deploy");
  assert.equal(started.sha256, sha256);
  assert.equal(started.checks.rules.passed, true);
  assert.equal(started.checks.rules.upgrade_authority, "pending", "mainnet's signer isn't configured here");
  assert.match((await w.call(w.dev, "request_mainnet_review", { program_id: programId, build_id })).data.error, /already has a review in progress/);

  await w.tick(); // the analysis sandbox
  await w.tick(); // the tools
  const analysis = [...w.boat.sandboxes.values()].find((s) => s.name.startsWith("mynt-program-analysis"));
  assert.equal(analysis.files.get("/home/user/mynt-gate/src/programs/mynt_program/src/lib.rs"), TEMPLATE["programs/mynt_program/src/lib.rs"], "the analysis gets the captured source");
  await w.tick(); // static analysis passes; the audit agent starts in that sandbox
  assert.equal(analysis.auditJob.deterministic_rules.passed, true, "the auditor sees Mynt's findings so far");
  assert.equal(analysis.auditJob.static_analysis.passed, true);
  const checklist = JSON.parse(analysis.files.get(`${workspaceCwd("program-audit")}/job/vulnerabilities.json`));
  assert.equal(checklist.version, loadVulnDb().version);
  assert.deepEqual(checklist.entries.map((e) => e.id), loadVulnDb().entries.map((e) => e.id), "the auditor gets the whole database as its checklist");
  // The auditor's token is metered against its own cap, on the gate's model.
  const auditRun = await w.gate.agentRun(w.boat.tokens["program-analysis"]);
  assert.equal(auditRun.key, `program-audit:${started.review_id}`);
  assert.equal(auditRun.capUsd, 5);
  await w.tick(); // the audit's findings: the invented critical doesn't verify, so nothing blocks
  let v = await w.review(started.review_id);
  assert.deepEqual(v.checks.audit.findings.map((f) => [f.id, f.verified]), [["A1", true], ["A2", false]]);
  assert.deepEqual(v.checks.audit.blocking, []);
  assert.equal(v.step, "red_provisioning");
  await w.tick(); // the red team gets the bytes and the IDL, never the source
  const red = [...w.boat.sandboxes.values()].find((s) => s.name.startsWith("mynt-program-red-team"));
  assert.ok(red.files.get(`${workspaceCwd("program-red-team")}/job/program.so.b64`));
  assert.ok(![...red.files.keys()].some((p) => p.endsWith(".rs")), "no source reaches the red team");
  assert.equal(red.redJob.program_id, programId);
  assert.equal(JSON.parse(red.files.get(`${workspaceCwd("program-red-team")}/job/vulnerabilities.json`)).entries.length, loadVulnDb().entries.length, "the red team gets the whole database");
  assert.equal((await w.gate.agentRun(w.boat.tokens["program-red-team"])).capUsd, 8);
  await w.tick(); // the report and the PoC, read back; Mynt's own sandbox re-runs it
  await w.tick();
  const confirm = [...w.boat.sandboxes.values()].find((s) => s.name.startsWith("mynt-program-poc-confirm"));
  assert.equal(confirm.files.get("/home/user/mynt-confirm/pocs/R1/run.sh"), "#!/bin/bash\necho attack\n");
  await w.tick(); // not confirmed: it doesn't block, and the PoC-less finding never did
  v = await w.review(started.review_id);
  assert.equal(v.status, "awaiting_approval", JSON.stringify(v.blocked_reason));
  assert.equal(v.checks.poc_confirmations.R1.confirmed, false);
  assert.deepEqual(v.checks.red_team.findings.map((f) => f.poc), ["R1", null]);
  assert.ok(v.cost_usd > 0);
  assert.ok(v.log.map((l) => l.event).includes("gates_passed"));
  // The audit agent never sees the red team's sandbox, and vice versa: separate sandboxes, all stopped.
  assert.equal(new Set([analysis, red, confirm]).size, 3);
  assert.ok(w.boat.stopped.length >= 3);

  // Still refused until an admin approves.
  assert.match((await w.call(w.dev, "deploy_program", { program_id: programId, build_id })).data.error, /awaiting_approval: an admin must approve it/);
  // Only admins decide.
  const devTools = (await w.dev.listTools()).tools.map((t) => t.name);
  assert.ok(devTools.includes("request_mainnet_review") && devTools.includes("get_mainnet_review") && devTools.includes("cancel_mainnet_review"));
  assert.ok(!devTools.includes("approve_mainnet_program") && !devTools.includes("reject_mainnet_program") && !devTools.includes("list_mainnet_reviews"));
  assert.equal((await w.ok(w.admin, "list_mainnet_reviews", { status: "awaiting_approval" }))[0].review_id, v.review_id);
  const approved = await w.ok(w.admin, "approve_mainnet_program", { review_id: v.review_id, note: "Gates clean; reviewed the report" });
  assert.equal(approved.status, "approved");
  assert.ok(approved.checks.audit && approved.checks.red_team, "the approval shows the audit report");
  // Approved: the gate lets this exact build through, to the signer (not configured in this world).
  r = await w.call(w.dev, "deploy_program", { program_id: programId, build_id });
  assert.match(r.data.error, /^Mainnet signer not configured/);
  // Another build's program, even of the same app, is not covered.
  const other = await w.build(programId, TEMPLATE, 2);
  assert.match((await w.call(w.dev, "deploy_program", { program_id: programId, build_id: other.build_id })).data.error, /latest review, .* is for a different build's program/);
  const logged = (await w.db.query("SELECT action FROM financial_products.audit_log WHERE target = $1 ORDER BY created_at", [programId])).rows.map((x) => x.action);
  assert.ok(logged.includes("request_mainnet_review") && logged.includes("approve_mainnet_program"), logged.join());
});

test("refusals: the hard rules stop a token program at once; a sure static finding, a missing or serious audit, and a confirmed exploit each block", async () => {
  // Hard rules: blocked before any sandbox or agent.
  let w = await world();
  let id = await w.mainnetProgram();
  let b = await w.build(id, fixture("token_vault"));
  const refused = await w.ok(w.dev, "request_mainnet_review", { program_id: id, build_id: b.build_id });
  assert.equal(refused.status, "blocked");
  assert.match(refused.blocked_reason, /^Hard rules: RUG-TOKEN-CPI \(source, programs\/token_vault\/src\/lib.rs:2\): uses anchor_spl::token/);
  assert.equal(w.boat.n, 0, "no sandbox was started");
  assert.match((await w.call(w.dev, "deploy_program", { program_id: id, build_id: b.build_id })).data.error, /is blocked/);

  const runTo = async (w) => {
    const id = await w.mainnetProgram();
    const b = await w.build(id);
    const r = await w.ok(w.dev, "request_mainnet_review", { program_id: id, build_id: b.build_id });
    await w.tick(10);
    return w.review(r.review_id);
  };
  // Static analysis: a cargo-audit vulnerability blocks; the ignore list Mynt passes is the operator's.
  w = await world({ static: { tools: [{ name: "cargo-audit", status: "ran", findings: [{ severity: "high", title: "RUSTSEC-2099-0001: bad", location: "crate 1.0" }] }, { name: "radar", status: "ran", findings: [] }] } }, { PROGRAM_GATE_CARGO_AUDIT_IGNORE: "RUSTSEC-2024-0001,not-an-id" });
  let v = await runTo(w);
  assert.equal(v.status, "blocked");
  assert.match(v.blocked_reason, /Static analysis: 1 critical\/high finding\(s\): cargo-audit: RUSTSEC-2099-0001/);
  assert.match([...w.boat.sandboxes.values()][0].analysisArgs, / 'RUSTSEC-2024-0001'$/);
  // The audit agent wrote nothing: no independent audit, no mainnet.
  w = await world({ audit: null });
  v = await runTo(w);
  assert.match(v.blocked_reason, /No complete independent audit/);
  // A verified high finding blocks.
  w = await world({ audit: { findings: [{ id: "A1", severity: "high", title: "Unchecked authority", file: "programs/mynt_program/src/lib.rs", quote: "has_one = authority", description: "d" }], summary: "s" } });
  v = await runTo(w);
  assert.match(v.blocked_reason, /Audit: 1 verified critical\/high finding\(s\): high Unchecked authority/);
  // A PoC Mynt's own re-run confirms blocks.
  w = await world({
    redTeam: { findings: [{ id: "R1", title: "Anyone resets any ledger", severity: "critical", category: "wrong_signer", description: "d", poc: "R1" }], attacks_tried: ["x"], summary: "s" },
    pocFiles: { "R1/run.sh": "#!/bin/bash\n" },
    confirm: { results: { R1: { confirmed: true, reason: "1 transaction(s) not signed by the victim changed 1 victim account(s)" } } },
  });
  v = await runTo(w);
  assert.equal(v.status, "blocked");
  assert.match(v.blocked_reason, /Red team: 1 exploit\(s\) confirmed by Mynt's own re-run: Anyone resets any ledger/);
  assert.equal(v.checks.poc_confirmations.R1.confirmed, true);
  // A PoC whose re-run Mynt couldn't complete fails the review (it can be requested again), never passes it.
  w = await world({ redTeam: { findings: [{ id: "R1", title: "t", severity: "high", category: "c", description: "d", poc: "R1" }], attacks_tried: ["x"], summary: "s" }, pocFiles: { "R1/run.sh": "x" }, confirm: "garbage" });
  v = await runTo(w);
  assert.equal(v.status, "failed");
});

test("a mainnet upgrade: announced to the firm when the gates pass, timelocked, cancellable, run by Mynt when the timelock ends", async () => {
  const w = await world({}, { MAINNET_UPGRADE_TIMELOCK_HOURS: "48" });
  const programId = await w.mainnetProgram();
  const first = await w.build(programId);
  // Deployed earlier (the deployer itself is tested in solana.test.js).
  await w.db.query("UPDATE financial_products.solana_programs SET status = 'deployed', version = 1, build_id = $2, verifiable_hash = $3, upgrade_authority = 'Vau1t11111111111111111111111111111111111111' WHERE program_id = $1", [programId, first.build_id, first.sha256]);
  assert.match((await w.call(w.dev, "request_mainnet_review", { program_id: programId, build_id: first.build_id })).data.error, /already deployed/);
  const next = await w.build(programId, TEMPLATE, 2);
  const req = await w.ok(w.dev, "request_mainnet_review", { program_id: programId, build_id: next.build_id });
  assert.equal(req.action, "upgrade");
  await w.tick(10);
  let v = await w.review(req.review_id);
  assert.equal(v.status, "awaiting_approval");
  const hours = (Date.parse(v.timelock.executes_at) - Date.now()) / 3600_000;
  assert.ok(hours > 47.9 && hours <= 48, `${hours}`);
  const [announced] = await w.deliveries("program.upgrade_scheduled");
  assert.equal(announced.data.program_id, programId);
  assert.equal(announced.data.verifiable_hash, next.sha256);
  assert.equal(announced.data.executes_at, v.timelock.executes_at);

  // Approved, but the timelock holds: upgrade_program is refused, and the worker doesn't start it.
  await w.ok(w.admin, "approve_mainnet_program", { review_id: req.review_id, note: "fine to ship" });
  assert.match((await w.call(w.dev, "upgrade_program", { program_id: programId, build_id: next.build_id })).data.error, /timelocked until/);
  const started = [];
  w.solana.deploy = async (user, p, buildId, action) => {
    started.push({ user: user.id, program: p.program_id, buildId, action });
    return p;
  };
  await w.tick();
  assert.equal(started.length, 0);
  // The developer cancels during the timelock: the firm hears of it.
  const cancelled = await w.ok(w.dev, "cancel_mainnet_review", { review_id: req.review_id });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await w.deliveries("program.upgrade_cancelled"))[0].data.reason, "cancelled by the developer");

  // Again; this time the timelock runs out and Mynt starts the upgrade itself, as the developer who asked.
  const again = await w.ok(w.dev, "request_mainnet_review", { program_id: programId, build_id: next.build_id });
  await w.tick(10);
  await w.ok(w.admin, "approve_mainnet_program", { review_id: again.review_id, note: "fine to ship" });
  await w.db.query("UPDATE financial_products.solana_mainnet_reviews SET executes_at = now() - interval '1 minute' WHERE id = $1", [again.review_id]);
  await w.gate.assertDeployable(await w.solana.get(programId), next.sha256, "upgrade"); // the gate itself now allows it
  await w.tick();
  assert.deepEqual(started, [{ user: w.devUser.id, program: programId, buildId: next.build_id, action: "upgrade" }]);
  assert.match((await w.call(w.dev, "cancel_mainnet_review", { review_id: again.review_id })).data.error, /already started/);
  // Once the program holds the reviewed bytes, the review is executed.
  await w.db.query("UPDATE financial_products.solana_programs SET verifiable_hash = $2, build_id = $3 WHERE program_id = $1", [programId, next.sha256, next.build_id]);
  await w.tick();
  v = await w.review(again.review_id);
  assert.equal(v.status, "executed");
  // An admin can reject a scheduled upgrade too; the firm hears of that as well.
  const third = await w.build(programId, TEMPLATE, 3);
  const r3 = await w.ok(w.dev, "request_mainnet_review", { program_id: programId, build_id: third.build_id });
  await w.tick(10);
  const rejected = await w.ok(w.admin, "reject_mainnet_program", { review_id: r3.review_id, note: "not now" });
  assert.equal(rejected.status, "rejected");
  assert.equal((await w.deliveries("program.upgrade_cancelled")).at(-1).data.reason, "rejected by an admin");
});

test("fail closed: without the gate, or without what the gate needs, mainnet can't be deployed", async () => {
  const w = await world();
  const programId = await w.mainnetProgram();
  const { build_id } = await w.build(programId);
  w.solana.gate = null;
  assert.match((await w.call(w.dev, "deploy_program", { program_id: programId, build_id })).data.error, /review gate isn't running/);
  const off = await MainnetGateService.open(w.db, w.store, w.solana, null, gateConfigFromEnv({ agentBackend: null, model: "m", publicUrl: "" }, {}));
  assert.equal(off.enabled, false);
  await assert.rejects(off.request(w.devUser, programId, build_id), /isn't available on this Mynt/);
});

test("the gate's agents are steered by their workspaces, with human-written skills vendored with their licences", () => {
  const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0"];
  for (const ws of ["program-audit", "program-red-team"]) {
    const files = workspaceFiles(ws);
    const skills = Object.keys(files).filter((p) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p));
    assert.ok(skills.length >= 3, ws);
    for (const s of skills) {
      const dir = s.replace("/SKILL.md", "");
      const u = JSON.parse(files[`${dir}/UPSTREAM.json`]);
      assert.ok(PERMISSIVE.includes(u.license), `${dir}: ${u.license}`);
      assert.match(u.commit, /^[0-9a-f]{40}$/);
      assert.equal(u.url, `https://github.com/${u.repo}/blob/${u.commit}/${u.path}`);
      assert.ok(files[`${dir}/LICENSE`]?.length > 100, `${dir} ships its licence`);
    }
  }
  assert.match(workspaceFiles("program-audit")["CLAUDE.md"], /job\/findings\.json/);
  assert.match(workspaceFiles("program-red-team")["CLAUDE.md"], /claim\.json[\s\S]*attack\.json/);
});

// ---- the vulnerability database ----

const REPO = new URL("..", import.meta.url).pathname;
const loadFixture = (dir) => {
  const abs = join(REPO, dir);
  const sources = sourcesOf(abs);
  const at = (f) => join(abs, f);
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(at(f), "utf8"));
    } catch {
      return null;
    }
  };
  const program = Buffer.from(elf());
  let o = 1000;
  for (const id of read("program.json")?.embeds ?? []) {
    Buffer.from(base58Decode(id)).copy(program, o);
    o += 40;
  }
  return { program_under_review: { name: "p", program_id: ID, sources, idl: read("idl.json"), program: new Uint8Array(program) }, static: read("static.json") };
};

test("vulnerability database: valid, versioned, every category covered, every entry referenced", () => {
  const db = loadVulnDb();
  assert.deepEqual(dbProblems(db), []);
  assert.ok(Number.isInteger(db.version) && db.version >= 1);
  assert.deepEqual([...new Set(db.entries.map((e) => e.category))].sort(), [...VULN_CATEGORIES].sort());
  assert.equal(new Set(db.entries.map((e) => e.id)).size, db.entries.length);
  for (const e of db.entries) {
    assert.ok(e.references.length && e.references.every((r) => r.url.startsWith("https://")), e.id);
    assert.ok(e.detection.some((d) => d.type !== "red_team_scenario"), `${e.id} has a detection Mynt runs or tests`);
  }
  // Rug pulls and Wormhole-style sysvar spoofing block; the other classes are leads for the auditor.
  assert.ok(db.entries.filter((e) => e.category === "rug_pull").every((e) => e.gate === "block"));
  assert.equal(db.entries.find((e) => e.id === "SIG-UNCHECKED-SYSVAR-LOAD").gate, "block");
  assert.equal(db.entries.find((e) => e.id === "AC-HAS-ONE").gate, "flag");
  // Malformed entries are refused, with what's wrong.
  assert.deepEqual(entryProblems(db.entries[0], new Set([db.entries[0].id])), [`id: ${db.entries[0].id} is already in the database`]);
  const bad = entryProblems({ id: "lower", title: "x", severity: "huge", category: "misc", gate: "maybe", description: "short", detection: [{ type: "source_pattern", pattern: "(", message: "m" }], references: [{ title: "t", url: "http://x" }], fixtures: {} });
  for (const re of [/^id:/, /^title/, /^severity/, /^category/, /^gate/, /^description/, /not a valid regular expression/, /^references/, /^fixtures/]) assert.ok(bad.some((p) => re.test(p)), `${re}: ${bad.join(" | ")}`);
});

test("vulnerability database: every entry catches its bad fixture and passes its good one", () => {
  const db = loadVulnDb();
  for (const e of db.entries) {
    const bad = loadFixture(e.fixtures.bad);
    const good = loadFixture(e.fixtures.good);
    const machine = e.detection.some((d) => ["source_pattern", "idl_shape", "bytecode_program_ref"].includes(d.type));
    if (machine) {
      const caught = runDetections(bad.program_under_review, db, (x) => x.id === e.id);
      assert.ok(caught.length > 0, `${e.id} misses its bad fixture ${e.fixtures.bad}`);
      assert.ok(caught.every((f) => f.rule === e.id && f.blocks === (e.gate === "block")), e.id);
      assert.deepEqual(runDetections(good.program_under_review, db, (x) => x.id === e.id), [], `${e.id} flags its good fixture ${e.fixtures.good}`);
    }
    if (e.detection.some((d) => d.type === "dependency_advisory")) {
      assert.equal(assessStatic(bad.static).passed, false, `${e.id}: cargo-audit's advisory blocks`);
      assert.equal(assessStatic(good.static).passed, true, e.id);
    }
    // Each detection signal an entry declares is exercised by its bad fixture.
    for (const signal of [["idl_shape", "idl"], ["bytecode_program_ref", "bytes"]])
      if (e.detection.some((d) => d.type === signal[0]) && (bad.program_under_review.idl || signal[1] === "bytes") && (signal[1] !== "bytes" || readFileSafe(join(REPO, e.fixtures.bad, "program.json"))))
        assert.ok(runDetections(bad.program_under_review, db, (x) => x.id === e.id).some((f) => f.signal === signal[1]), `${e.id}: ${signal[1]} signal`);
  }
  // The template every coding agent starts from has none of them, flag or block.
  assert.deepEqual(runDetections({ name: "p", program_id: ID, program: elf(), idl: null, sources: TEMPLATE }, db), []);
});

const readFileSafe = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

test("vulnerability database: suggestions from new RustSec advisories, for review only", () => {
  const db = loadVulnDb();
  const advisories = [
    { id: "RUSTSEC-2026-0144", summary: "Program<'info, System> is not properly validated", published: "2026-10-01T00:00:00Z", affected: [{ package: { name: "anchor-lang", ecosystem: "crates.io" } }] },
    { id: "GHSA-xxxx", aliases: ["RUSTSEC-2022-0093"], summary: "Double public key signing oracle", published: "2022-06-01T00:00:00Z", affected: [{ package: { name: "ed25519-dalek" } }] },
    { id: "RUSTSEC-2026-0001", summary: "Unrelated web crate", published: "2026-10-01T00:00:00Z", affected: [{ package: { name: "hyper" } }] },
    { id: "RUSTSEC-2024-0344", summary: "Already in the database", published: "2024-06-01T00:00:00Z", affected: [{ package: { name: "curve25519-dalek" } }] },
  ];
  const all = suggestFromAdvisories(advisories, db);
  assert.deepEqual(all.map((e) => e.id), ["DEP-RUSTSEC-2026-0144", "DEP-RUSTSEC-2022-0093"]);
  for (const e of all) assert.deepEqual(entryProblems(e, new Set(db.entries.map((x) => x.id))), [], "a suggestion is a well-formed entry");
  assert.deepEqual(suggestFromAdvisories(advisories, db, { since: "2026-01-01" }).map((e) => e.id), ["DEP-RUSTSEC-2026-0144"]);
});

test("a new database version re-checks deployed mainnet programs: a failing one is flagged to its firm and admins, upgrades pause until reviewed, nothing goes down", async () => {
  const w = await world();
  const programId = await w.mainnetProgram();
  const first = await w.build(programId);
  await w.db.query("UPDATE financial_products.solana_programs SET status = 'deployed', version = 1, build_id = $2, verifiable_hash = $3, upgrade_authority = 'Vau1t11111111111111111111111111111111111111' WHERE program_id = $1", [programId, first.build_id, first.sha256]);
  // Version 1 applied: the template passes, nothing flagged.
  await w.tick();
  assert.deepEqual(await w.ok(w.admin, "list_program_flags", {}), []);
  // Version 2 adds a blocking rule this program breaks.
  const db = loadVulnDb();
  w.gate.vulnDb = {
    ...db,
    version: db.version + 1,
    entries: [
      ...db.entries,
      { id: "TEST-LEDGER-COUNT", title: "A test rule", severity: "high", category: "resource", gate: "block", description: "A rule only this test uses, to stand for a new class.", detection: [{ type: "source_pattern", pattern: "ledger\\.count\\s*=", message: "writes ledger.count" }], references: [{ title: "t", url: "https://example.com" }], fixtures: { bad: "x", good: "y" } },
    ],
  };
  await w.tick();
  const flags = await w.ok(w.admin, "list_program_flags", { status: "open" });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].program_id, programId);
  assert.equal(flags[0].db_version, db.version + 1);
  assert.equal(flags[0].findings[0].rule, "TEST-LEDGER-COUNT");
  const [event] = await w.deliveries("program.review_flagged");
  assert.equal(event.data.program_id, programId);
  assert.equal(event.data.upgrades_paused, true);
  assert.equal(event.data.program_running, true);
  assert.equal((await w.solana.get(programId)).status, "deployed", "never taken down");
  // Admins see it in ops_status too.
  const { opsStatus } = await import("../dist/ops.js");
  assert.ok((await opsStatus(w.db, { backupStatusFile: "/nonexistent" })).attention.some((a) => /1 mainnet program\(s\) flagged by the vulnerability database/.test(a)));
  // Once per version.
  await w.tick();
  assert.equal((await w.ok(w.admin, "list_program_flags", {})).length, 1);
  // Upgrades wait for an admin's review.
  const next = await w.build(programId, TEMPLATE, 2);
  assert.match((await w.call(w.dev, "request_mainnet_review", { program_id: programId, build_id: next.build_id })).data.error, /Upgrades of this program are paused/);
  await assert.rejects(w.gate.assertDeployable(await w.solana.get(programId), next.sha256, "upgrade"), /paused/);
  assert.ok(!(await w.dev.listTools()).tools.some((t) => t.name === "resolve_program_flag"), "admins review flags");
  await w.ok(w.admin, "resolve_program_flag", { flag_id: flags[0].id, note: "Reviewed with the firm; the fix ships as the next upgrade" });
  const req = await w.ok(w.dev, "request_mainnet_review", { program_id: programId, build_id: next.build_id });
  // The new version's rule applies to the upgrade's review too.
  assert.equal(req.status, "blocked");
  assert.match(req.blocked_reason, /TEST-LEDGER-COUNT/);
  assert.equal(req.checks.rules.db_version, db.version + 1);
});

test("admins list the vulnerability rules and propose new ones; proposals never change the database", async () => {
  const w = await world();
  const listed = await w.ok(w.admin, "list_vulnerability_rules", {});
  assert.equal(listed.version, loadVulnDb().version);
  assert.equal(listed.entries.length, loadVulnDb().entries.length);
  assert.ok(listed.entries.find((e) => e.id === "RUG-HARDCODED-ADMIN").detection.includes("source_pattern:hardcoded_admin"));
  assert.ok((await w.ok(w.admin, "list_vulnerability_rules", { category: "signatures" })).entries.every((e) => e.category === "signatures"));
  const entry = { id: "CPI-NEW-CLASS", title: "A new CPI class", severity: "high", category: "cpi", gate: "flag", description: "Something the database doesn't cover yet, described properly.", detection: [{ type: "source_pattern", pattern: "\\bnew_thing\\s*\\(", message: "new_thing" }], references: [{ title: "Write-up", url: "https://example.com/write-up" }], fixtures: { bad: "test/fixtures/solana-vulns/CPI-NEW-CLASS/bad", good: "test/fixtures/solana-vulns/CPI-NEW-CLASS/good" } };
  const proposed = await w.ok(w.admin, "propose_vulnerability_rule", { entry, rationale: "Seen in a public post-mortem this week" });
  assert.equal(proposed.status, "proposed");
  assert.match((await w.call(w.admin, "propose_vulnerability_rule", { entry: { ...entry, id: "RUG-TOKEN-CPI" }, rationale: "a duplicate of an entry" })).data.error, /already in the database/);
  const after = await w.ok(w.admin, "list_vulnerability_rules", {});
  assert.equal(after.entries.length, loadVulnDb().entries.length, "the database itself is unchanged");
  assert.equal(after.proposals[0].entry.id, "CPI-NEW-CLASS");
  assert.ok(!(await w.dev.listTools()).tools.some((t) => t.name === "propose_vulnerability_rule"));
});
