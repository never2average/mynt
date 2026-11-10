#!/usr/bin/env node
// The partner walkthrough: Mynt's whole story, scripted, on sandbox data, for a meeting with a prospective licence
// partner and as proof that the pieces work together. It runs entirely on this computer: an in-process Mynt server
// on a throwaway in-process Postgres (PGlite), the same way the tests run, with stand-ins for every outside party
// (the public registers, the identity and bank-transfer partner, the partner's webhook). No production server,
// database or key is touched.
//
//   npm run demo:partner                 # the whole story, then everything it made is removed
//   npm run demo:partner -- --keep       # leave the database and files for inspection (prints how to remove them)
//   npm run demo:partner -- --cleanup-only --dir <path printed by --keep>
//   npm run demo:partner -- --devnet --program-id <address> --publisher-key <keypair.json> [--funding-key <keypair.json>] [--rpc <devnet url>]
//
// --devnet anchors the health snapshots on Solana devnet instead of the in-memory stand-in chain: a product-health
// program you deployed there for demos (scripts/product-health-deploy.sh), the key its config names as publisher,
// and the public devnet RPC. Devnet only: the RPC must answer devnet's genesis hash. See docs/demo.md.
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = new URL("../../", import.meta.url);
const HOUR = 3_600_000;
const PRODUCT = "example-dollar-transfer";
const DIR_PREFIX = "mynt-partner-demo-";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

// ---- placeholders: every name and number below is made up, for this demo only ----
const LEI_BODY = "PLACEHOLDER0DEMO00"; // 18 characters; the check digits are computed so the format is valid
const leiOf = (body) => {
  let rem = 0;
  for (const ch of `${body}00`) for (const d of /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)) rem = (rem * 10 + Number(d)) % 97;
  return `${body}${String(98 - rem).padStart(2, "0")}`;
};
const PLACEHOLDER_LEI = leiOf(LEI_BODY);
const PROVIDER_NAME = "Example Money Transmitter (placeholder)";
const VENDOR_NAME = "Example Identity and Transfer Partner (placeholder)";
const FUND_NAME = "Example Liquidity Fund (placeholder)";
const CUSTOMERS = {
  verified: { ref: "demo-customer-ny", full_name: "Avery Placeholder", identity: { result: "match", residential_state: "us-ny" } },
  unverified: { ref: "demo-customer-unverified", full_name: "Blake Placeholder", identity: { result: "no_match" } },
  texas: { ref: "demo-customer-tx", full_name: "Casey Placeholder", identity: { result: "match", residential_state: "us-tx" } },
};
const CUSTOMER_FIELDS = { date_of_birth: "1990-01-01", ssn: "123-45-6789", bank_account_number: "123456789012", routing_number: "021000021" };

const usd = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps) => `${(bps / 100).toFixed(0)}%`;

// ---- small servers on 127.0.0.1, each closed at the end ----
async function listen(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => Promise.resolve(handler(req, res, raw)).catch((e) => res.writeHead(500).end(String(e?.message ?? e))));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const sendJson = (res, status, body, type = "application/json") => res.writeHead(status, { "Content-Type": type }).end(JSON.stringify(body));

// The public registers Mynt checks a licence provider against (GLEIF's LEI records, FinCEN's MSB list), answering
// for the placeholder firm only.
function registersStandIn() {
  const HEADER = "LEGAL NAME\tDBA NAME\tSTREET ADDRESS\tCITY\tSTATE\tZIP\tMSB ACTIVITIES\tSTATES OF MSB ACTIVITIES\tALL STATES & TERRITORIES & FOREIGN FLAG**\tFOREIGN LOCATION\t# OF BRANCHES\tAUTH SIGN DATE\tRECEIVED DATE";
  const row = (name, state) => [name, "", "1 Example Street", "New York", state, "10001", "409", "NY CA", "", "", "0", "01/15/2026", "01/15/2026"].join("\t");
  const msbList = [HEADER, row("Unrelated Example Exchange LLC", "TX"), row(PROVIDER_NAME, "NY"), "", "", "** ALL STATES & TERRITORIES FLAG", ""].join("\r\n");
  const record = {
    data: {
      type: "lei-records",
      id: PLACEHOLDER_LEI,
      attributes: {
        lei: PLACEHOLDER_LEI,
        entity: {
          legalName: { name: PROVIDER_NAME, language: "en" },
          legalAddress: { addressLines: ["1 Example Street"], city: "Wilmington", region: "US-DE", country: "US", postalCode: "19801" },
          headquartersAddress: { addressLines: ["1 Example Street"], city: "New York", region: "US-NY", country: "US", postalCode: "10001" },
          registeredAt: { id: "RA000602", other: null },
          registeredAs: "PLACEHOLDER-0000000",
          jurisdiction: "US-DE",
          legalForm: { id: "XTIQ", other: null },
          status: "ACTIVE",
        },
        registration: { status: "ISSUED", nextRenewalDate: "2027-12-31T00:00:00Z", corroborationLevel: "FULLY_CORROBORATED" },
      },
    },
  };
  return listen((req, res) => {
    if (req.url === `/gleif/${PLACEHOLDER_LEI}`) return sendJson(res, 200, record, "application/vnd.api+json");
    if (req.url.startsWith("/gleif/")) return sendJson(res, 404, { errors: [{ status: "404" }] }, "application/vnd.api+json");
    if (req.url === "/fincen" && req.method === "POST") return res.writeHead(200, { "Content-Type": "application/vnd.ms-excel" }).end(msbList);
    res.writeHead(404).end();
  });
}

// The identity and bank-transfer partner: identity checks that name the customer's state, quotes, and transfers that
// settle at once. Its test and live endpoints are two paths of one local server; it never moves money.
// Like a real partner, it answers only requests Mynt signed with a secret it was given, and recently.
function partnerStandIn(log, secrets) {
  return listen((req, res, raw) => {
    const m = /^\/(test|live)\/v1\/([a-z_]+)$/.exec(req.url);
    if (!m || req.method !== "POST") return res.writeHead(404).end();
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["mynt-signature"] ?? "");
    const fresh = sig && Math.abs(Date.now() / 1000 - Number(sig[1])) <= 300;
    if (!fresh || ![...secrets].some((k) => createHmac("sha256", k).update(`${sig[1]}.${raw}`).digest("hex") === sig[2])) return sendJson(res, 401, { error: "bad signature" });
    const body = JSON.parse(raw || "{}");
    const key = m[2];
    const ok = (output) => sendJson(res, 200, { request_id: body.request_id, status: "ok", output });
    log.push({ endpoint: m[1], key });
    if (key === "identity_verification") {
      const who = Object.values(CUSTOMERS).find((c) => c.full_name === body.input?.full_name);
      return ok(who ? who.identity : { result: "match", residential_state: "us-ny" });
    }
    if (key === "onramp_quote" || key === "offramp_quote") {
      const amount = String(body.params?.amount_usd ?? "100.00");
      const fee = "0.00";
      return ok({ quote_id: `demo-q-${randomUUID()}`, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), direction: key === "onramp_quote" ? "in" : "out", amount_usd: amount, fee_usd: fee, total_usd: amount, currency: "USD", estimated_arrival: null, settlement_asset: "USDC", settlement_network: "solana", settlement_amount: amount });
    }
    if (key === "onramp_transfer") return ok({ transfer_status: "settled", estimated_arrival: null, total_usd: null, settlement_ref: `demo-ref-${randomUUID().slice(0, 8)}`, settlement_tx: null });
    if (key === "offramp_transfer") return ok({ transfer_status: "settled", estimated_arrival: null, total_usd: null, paid_out_usd: null, settlement_ref: `demo-ref-${randomUUID().slice(0, 8)}`, settlement_tx: null });
    res.writeHead(404).end();
  });
}

// The licence provider's webhook: keeps what arrives and checks Mynt's signature with the secret it was given.
function webhookReceiver(received, secretOf) {
  return listen((req, res, raw) => {
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["mynt-signature"] ?? "");
    const secret = secretOf();
    const valid = !!sig && !!secret && createHmac("sha256", secret).update(`${sig[1]}.${raw}`).digest("hex") === sig[2];
    received.push({ body: JSON.parse(raw), signature_valid: valid });
    res.writeHead(200).end("ok");
  });
}

// ---- the chain: an in-memory stand-in that enforces what the program enforces, or the real devnet program ----
function makeFakeChain(lib, programId) {
  return {
    programId,
    publisher: "DemoPub1isher111111111111111111111111111111",
    heads: new Map(),
    txs: [],
    async head(subject, pid = programId) {
      return this.heads.get(`${pid}:${Buffer.from(subject).toString("hex")}`) ?? null;
    },
    async latestRecordTx() {
      return null;
    },
    async hasHeadHistory() {
      return false;
    },
    apply(subject, kind, e) {
      const k = `${programId}:${Buffer.from(subject).toString("hex")}`;
      const head = this.heads.get(k);
      if (e.sequence !== (head?.sequence ?? 0) + 1) throw new Error("the program refuses anything but the next sequence");
      if (head && e.period_start !== head.period_end) throw new Error("periods must be contiguous");
      const fingerprint = e.fingerprint ?? lib.ZERO_32;
      const partner_commitment = e.partner_commitment ?? lib.ZERO_32;
      const source = lib.SOURCE_FLAG[e.source] ?? 0;
      const chain = lib.nextChain(head?.chain ?? lib.ZERO_32, { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source, partner_commitment });
      this.heads.set(k, { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source, partner_signed: !!e.partner_commitment, partner_commitment, mynt_signer: this.publisher, chain });
      const tx = `demo-tx-${this.txs.length + 1}`;
      this.txs.push(tx);
      return tx;
    },
    async publishSnapshot(subject, entry) {
      return this.apply(subject, lib.KIND_SNAPSHOT, entry);
    },
    async publishMissed(subject, entry) {
      return this.apply(subject, lib.KIND_MISSED, entry);
    },
  };
}

// The program's head account, as getAccountInfo returns it, for the stand-in RPC the verifier reads.
function headAccountData(lib, codec, h) {
  const data = Buffer.alloc(lib.HEAD_SIZE);
  Buffer.from(codec.anchorDiscriminator("account", "Head")).copy(data, 0);
  Buffer.from(h.subject).copy(data, 8);
  data.writeBigUInt64LE(BigInt(h.sequence), 40);
  Buffer.from(h.fingerprint).copy(data, 48);
  data.writeBigInt64LE(BigInt(h.period_start), 80);
  data.writeBigInt64LE(BigInt(h.period_end), 88);
  data[96] = h.kind;
  data[97] = h.source;
  data[98] = h.partner_signed ? 1 : 0;
  Buffer.from(h.partner_commitment).copy(data, 99);
  return data;
}
function chainRpcStandIn(lib, codec, chain) {
  return listen((req, res, raw) => {
    const { method, id, params } = JSON.parse(raw);
    let result = null;
    if (method === "getAccountInfo") {
      const head = [...chain.heads.values()].find((h) => lib.headAddress(chain.programId, h.subject) === params[0]);
      result = { context: { slot: 1 }, value: head ? { owner: chain.programId, lamports: 0, executable: false, data: [headAccountData(lib, codec, head).toString("base64"), "base64"] } : null };
    }
    sendJson(res, 200, { jsonrpc: "2.0", id, result });
  });
}

// Devnet: the deployed product-health program, written to through the same guarded publisher Mynt uses.
async function makeDevnetChain({ lib, codec, tx, rpcUrl, programId, publisherKey, fundingKey, say }) {
  let id = 0;
  const rpc = async (method, params = []) => {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 400)}`);
    return body.result;
  };
  if ((await rpc("getGenesisHash")) !== DEVNET_GENESIS) throw new Error("That RPC isn't Solana devnet: the demo writes to devnet only");
  const { value: config } = await rpc("getAccountInfo", [lib.configAddress(programId), { encoding: "base64", commitment: "confirmed" }]);
  if (!config) throw new Error(`The product-health program ${programId} isn't initialised on devnet: deploy and initialise it first (scripts/product-health-deploy.sh)`);
  const named = lib.decodeConfigPublisher(Buffer.from(config.data[0], "base64"));
  if (named !== publisherKey.address) throw new Error(`The program names ${named} as its publisher, not the key you gave (${publisherKey.address})`);
  const publisher = new lib.HealthPublisher(publisherKey, programId);
  const confirm = async (signature) => {
    for (let i = 0; i < 120; i++) {
      const { value } = await rpc("getSignatureStatuses", [[signature]]);
      if (value[0]?.err) throw new Error(`transaction failed: ${JSON.stringify(value[0].err)}`);
      if (["confirmed", "finalized"].includes(value[0]?.confirmationStatus)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("not confirmed in time");
  };
  const send = async (payer, signerOf, ixs) => {
    const { value } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const message = tx.compileMessage(payer, ixs, value.blockhash);
    const signatures = new Map();
    for (const s of message.signers) signatures.set(s, await signerOf(s).sign(message.bytes));
    const signature = await rpc("sendTransaction", [Buffer.from(tx.serializeTransaction(message, signatures)).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    await confirm(signature);
    return signature;
  };
  const balance = async (address) => (await rpc("getBalance", [address, { commitment: "confirmed" }])).value;
  const transfer = (from, to, lamports) => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(BigInt(lamports), 4);
    return send(from.address, () => from, [{ programId: "11111111111111111111111111111111", keys: [{ pubkey: from.address, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data }]);
  };
  const FLOAT = 20_000_000; // 0.02 SOL: fees and a head account's rent, with room to spare
  const fundedBy = [];
  if (fundingKey && (await balance(publisher.address)) < FLOAT) {
    const sig = await transfer(fundingKey, publisher.address, FLOAT);
    fundedBy.push({ from: fundingKey.address, lamports: FLOAT, signature: sig });
    say(`  devnet: the funding key ${fundingKey.address} sent 0.02 SOL to the publisher ${publisher.address}`);
  }
  const heads = [];
  const chain = {
    programId,
    publisher: publisher.address,
    devnet: true,
    heads,
    async head(subject, pid = programId) {
      const { value } = await rpc("getAccountInfo", [lib.headAddress(pid, subject), { encoding: "base64", commitment: "confirmed" }]);
      if (!value) return null;
      if (value.owner !== pid) throw new Error("The head account isn't owned by the product-health program");
      return lib.decodeHead(Buffer.from(value.data[0], "base64"));
    },
    async hasHeadHistory(subject, pid = programId) {
      return (await rpc("getSignaturesForAddress", [lib.headAddress(pid, subject), { limit: 1, commitment: "confirmed" }])).length > 0;
    },
    async latestRecordTx() {
      return null;
    },
    async publishSnapshot(subject, entry, opening) {
      if (opening) heads.push(lib.headAddress(programId, subject));
      return send(publisher.address, () => publisher, [...(opening ? [lib.healthIx.openSubject(programId, publisher.address, subject)] : []), lib.healthIx.recordSnapshot(programId, publisher.address, subject, entry)]);
    },
    async publishMissed(subject, entry, opening) {
      if (opening) heads.push(lib.headAddress(programId, subject));
      return send(publisher.address, () => publisher, [...(opening ? [lib.healthIx.openSubject(programId, publisher.address, subject)] : []), lib.healthIx.recordMissed(programId, publisher.address, subject, entry)]);
    },
    // What can be given back: the publisher's leftover SOL to the funding key (the publisher itself stays, since the
    // program's config names it). Head accounts can't be closed: the program has no instruction that closes one.
    async cleanup() {
      const out = { cleaned: [], left: [] };
      for (const address of heads) {
        const { value } = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]).catch(() => ({ value: null }));
        out.left.push(`devnet head account ${address} (${value ? `${value.lamports} lamports of rent` : "rent unknown"}): the product-health program has no instruction to close a head, by design, so its record can't be erased`);
      }
      if (fundingKey) {
        const left = await balance(publisher.address);
        const fee = 5000;
        if (left > fee) {
          const sig = await transfer(publisherKey, fundingKey.address, left - fee);
          out.cleaned.push(`returned ${left - fee} lamports of devnet SOL from the publisher ${publisher.address} to the funding key ${fundingKey.address} (${sig})`);
        }
      } else out.left.push(`the publisher ${publisher.address} keeps its devnet SOL (no --funding-key to return it to)`);
      return out;
    },
  };
  return { chain, fundedBy };
}

// ---- cleanup: whatever a run made, removed at the end, on failure and on Ctrl-C ----
class Cleanup {
  #steps = [];
  done = [];
  left = [];
  add(what, fn) {
    this.#steps.push({ what, fn });
  }
  async run() {
    for (const { what, fn } of this.#steps.splice(0).reverse()) {
      try {
        const r = await fn();
        if (r && (r.cleaned || r.left)) {
          this.done.push(...(r.cleaned ?? []));
          this.left.push(...(r.left ?? []));
        } else this.done.push(what);
      } catch (e) {
        this.left.push(`${what}: ${e.message}`);
      }
    }
  }
}

// ---- the walkthrough ----
export async function runPartnerWalkthrough({ devnet = null, keep = false, say = console.log, parentDir = tmpdir() } = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("The partner walkthrough never runs with NODE_ENV=production");
  process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
  const cleanup = new Cleanup();
  const summary = [];
  const started = Date.now();
  const step = (n, title) => say(`\n== ${n}. ${title} ==  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  const note = (s) => say(`   ${s}`);
  const result = (n, what, outcome, ok = true) => summary.push({ step: n, what, outcome, ok });
  const dir = mkdtempSync(join(parentDir, DIR_PREFIX));
  const unhook = installSignalCleanup(cleanup);
  cleanup.add(`removed the working folder ${dir} (database and files)`, async () => {
    if (keep) return { left: [`kept ${dir} for inspection (database and files); remove it with: npm run demo:partner -- --cleanup-only --dir ${dir}`] };
    rmSync(dir, { recursive: true, force: true });
    return { cleaned: [`removed the working folder ${dir} (database and files)`] };
  });
  let out;
  let failure = null;
  try {
    out = await walk({ devnet, keep, dir, say, step, note, result, cleanup });
  } catch (e) {
    failure = e;
    summary.push({ step: "!", what: "The walkthrough stopped", outcome: e.message.slice(0, 300), ok: false });
  } finally {
    await cleanup.run();
    unhook();
  }
  say("\n== Summary ==");
  const width = Math.max(...summary.map((s) => s.what.length), 10);
  for (const s of summary) say(`${s.ok ? "PASS" : "FAIL"}  ${String(s.step).padEnd(2)} ${s.what.padEnd(width)}  ${s.outcome}`);
  say("\n== Cleaned up ==");
  for (const c of cleanup.done) say(`- ${c}`);
  for (const c of cleanup.left) say(c.startsWith("kept ") ? `- ${c}` : `- NOT cleaned up: ${c}`);
  if (failure) {
    failure.summary = summary;
    failure.cleaned = cleanup.done;
    failure.not_cleaned = cleanup.left;
    throw failure;
  }
  return { ...out, summary, cleaned: cleanup.done, not_cleaned: cleanup.left, dir, kept: keep, passed: summary.every((s) => s.ok) };
}

function installSignalCleanup(cleanup) {
  const handler = (signal) => {
    console.error(`\n${signal}: cleaning up before exiting`);
    cleanup.run().finally(() => process.exit(130));
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

async function walk({ devnet, keep, dir, say, step, note, result, cleanup }) {
  const imp = (p) => import(new URL(p, ROOT).href);
  const { PGlite } = await import("@electric-sql/pglite");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer } = await imp("dist/server.js");
  const { createMcpHttpServer } = await imp("dist/http.js");
  const { Store } = await imp("dist/store.js");
  const { setFirmCheckSourcesForTests } = await imp("dist/firm-checks.js");
  const { ProductHealthService } = await imp("dist/product-health.js");
  const { CovenantService } = await imp("dist/covenants.js");
  const { LiquidityWorker, exitedLiquidityProvider, liquidityProviderBooks, liquidityProvidersOf, openWithdrawalRequests, poolSponsorOf, poolsOf } = await imp("dist/liquidity.js");
  const { flowsFor } = await imp("dist/money-rails.js");
  const { deliverDueWebhooks } = await imp("dist/runtime.js");
  const lib = await imp("dist/solana/product-health-chain.js");
  const codec = await imp("dist/solana/codec.js");
  const txlib = await imp("dist/solana/tx.js");
  const { applyRegulatoryModel } = await imp("scripts/regulatory-model.mjs");
  const { loadFixture, runSponsoredProduct } = await imp("scripts/sponsored-product.mjs");

  // The database: PGlite in memory, gone when it's closed; with --keep, in the working folder, for inspection.
  const pg = keep ? new PGlite(join(dir, "pgdata")) : new PGlite();
  cleanup.add("closed the in-process database", () => pg.close());
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db);
  const VENDORS = { allowInsecureLoopback: true, timeoutMs: 5000 };

  // The stand-ins, each closed at the end.
  const serve = async (what, made) => {
    const s = await made;
    cleanup.add(`stopped the ${what} (${s.url})`, () => new Promise((r) => (s.server.closeAllConnections(), s.server.close(() => r()))));
    return s;
  };
  const registers = await serve("stand-in public registers", registersStandIn());
  setFirmCheckSourcesForTests({ gleif: `${registers.url}/gleif/`, fincen: `${registers.url}/fincen` });
  cleanup.add("pointed the firm checks back at the real registers", () => setFirmCheckSourcesForTests(null));
  const partnerCalls = [];
  const partnerSecrets = new Set();
  const partner = await serve("stand-in identity and transfer partner", partnerStandIn(partnerCalls, partnerSecrets));
  const hooks = [];
  let hookSecret = null;
  const receiver = await serve("licence provider's webhook receiver", webhookReceiver(hooks, () => hookSecret));

  // The clock the health, covenant and pool workers run on: whole hours, starting a few hours back, so every period
  // a snapshot covers has ended (devnet's program refuses a period that ends in the future).
  let clock = Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR + 5 * 60_000;
  const now = () => new Date(clock);

  // The partner's books as a sandbox ledger: test figures the script sets as the story goes, never real money.
  const books = { reserves: 150_000_00, owed: 100_000_00 };
  const ledger = { id: "demo-sandbox", name: "Demo sandbox ledger (test figures, not real money)", kind: "sandbox", read: async (c) => ({ reserves_held_cents: books.reserves, customer_obligations_cents: books.owed, as_of: c.period_end }) };

  let chain;
  let rpcUrl;
  if (devnet) {
    const made = await makeDevnetChain({ lib, codec, tx: txlib, rpcUrl: devnet.rpc, programId: devnet.programId, publisherKey: devnet.publisherKey, fundingKey: devnet.fundingKey, say });
    chain = made.chain;
    rpcUrl = devnet.rpc;
    cleanup.add("devnet", () => chain.cleanup());
  } else {
    chain = makeFakeChain(lib, "GLi9SM8q1Q8S1k5SFHWpZ7v9uWK9M5ZDxhd6ESjuSfVz");
    rpcUrl = (await serve("stand-in chain RPC", chainRpcStandIn(lib, codec, chain))).url;
  }
  const health = await ProductHealthService.open(db, store, { intervalMs: HOUR, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: chain.programId }, {
    chain,
    ledgerFor: () => ledger,
    flowsFor: (productId, from, to) => flowsFor(store, productId, from, to),
    now,
    liquidityProvidersOf: (id) => liquidityProvidersOf(store, id),
    exitedLiquidityProvider: (id, firm) => exitedLiquidityProvider(store, id, firm),
    liquidityProviderBooks: (id, firm) => liquidityProviderBooks(store, id, firm),
    poolsOf: (id) => poolsOf(store, id),
    poolSponsorOf: (id) => poolSponsorOf(store, id),
    openWithdrawalRequests: (id, pool) => openWithdrawalRequests(store, id, pool),
  });
  const covenants = await CovenantService.open(db, store, health, { pollMs: 60_000 }, { now });
  const pools = new LiquidityWorker(store, health, { maxHealthAgeMs: 30 * HOUR, pollMs: 60_000 }, { now });
  const ctx = { productHealth: health, covenants, vendors: VENDORS };

  // Everyone's MCP session, in process.
  const clients = [];
  cleanup.add("closed the in-process sessions", () => Promise.all(clients.map((c) => c.close().catch(() => {}))));
  const session = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, ctx).connect(s);
    const client = new Client({ name: "partner-walkthrough", version: "0" });
    await client.connect(c);
    clients.push(client);
    const call = async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      let data;
      try {
        data = JSON.parse(res.content[0].text);
      } catch {
        data = { error: res.content[0].text };
      }
      return { isError: res.isError ?? false, data };
    };
    call.listTools = async () => (await client.listTools()).tools;
    return call;
  };
  const must = async (call, name, args) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.data).slice(0, 600)}`);
    return r.data;
  };

  // The runtime API (apps' servers and devices), on 127.0.0.1.
  const api = createMcpHttpServer(store, null, ctx, { publicUrl: "http://127.0.0.1", vendors: VENDORS }).listen(0, "127.0.0.1");
  await new Promise((r) => api.once("listening", r));
  cleanup.add("stopped the local runtime API", () => new Promise((r) => (api.closeAllConnections(), api.close(() => r()))));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  const rest = async (method, path, secret, body) => {
    const res = await fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  };

  // People. Signing in is simulated: each person is a user row with their role, as Clerk sign-in would create.
  const FIXTURE = loadFixture();
  const { user: adminUser } = await store.createUser("Demo admin", ["admin"]);
  const admin = await session(adminUser);
  const lpUser = await store.upsertClerkUser("demo_lp", FIXTURE.licence_provider.member_email, "Demo licence provider", ["license_provider"]);
  const provider = await session(lpUser);
  const { user: builderUser } = await store.createUser("Demo builder", ["developer"]);
  const builder = await session(builderUser);
  const sessions = { admin, licence_provider: provider, builder };

  say("Mynt partner walkthrough: sandbox data, every outside party a local stand-in, nothing leaves this computer.");
  say(`Chain: ${devnet ? `Solana devnet, program ${chain.programId}` : "in-memory stand-in for the product-health program"}. Working folder: ${dir}`);
  const applied = await applyRegulatoryModel({ call: (n, a) => admin(n, a), listTools: admin.listTools, model: JSON.parse(readFileSync(new URL("schemas/regulatory/us.json", ROOT), "utf8")) });
  if (!applied.applied) throw new Error(`The US regulatory model didn't load: ${JSON.stringify(applied.problems)}`);
  note("Loaded the US regulatory model (regulators, licence types, service types) from schemas/regulatory/us.json.");

  // ---- 1 ----
  step(1, "An admin adds the licence provider, and Mynt checks it's a real company");
  const firm = await must(admin, "register_firm", {
    name: PROVIDER_NAME,
    regions: ["US"],
    legal_form: "company_private",
    incorporation: { country: "us", subdivision: "us-de" },
    identifiers: [{ scheme: "lei", value: PLACEHOLDER_LEI }],
  });
  note(`Admin registered '${firm.name}' (placeholder: fake LEI ${PLACEHOLDER_LEI}, fake licence numbers, staging only).`);
  const before = await must(admin, "list_entities", {});
  note(`Before any check: may sponsor? ${before.find((e) => e.id === firm.id)?.legitimacy?.passes ? "yes" : "no"}.`);
  const checks = await must(admin, "run_firm_checks", { entity_id: firm.id });
  for (const r of checks.results) note(`${r.source}: ${r.status} (${r.fields?.legal_name ?? r.fields?.state ?? ""}) from ${r.url}, hash ${String(r.response_hash).slice(0, 19)}...`);
  note(`Legitimacy rule passes: ${checks.legitimacy.passes ? "yes" : "no"}.`);
  result(1, "Licence provider added and checked", `GLEIF ${checks.results.find((r) => r.source === "gleif_lei")?.status}, FinCEN ${checks.results.find((r) => r.source === "fincen_msb")?.status}, may sponsor: ${checks.legitimacy.passes}`, checks.legitimacy.passes);

  // ---- 2 ----
  step(2, "A builder makes a money-transmission product; the provider sponsors it in New York and California");
  const run = await runSponsoredProduct({ call: (name, input, actor) => sessions[actor](name, input), staging: true, say: (s) => note(s) });
  if (!run.done) throw new Error(`The sponsored product stopped at ${run.stopped_at}: ${run.reason}`);
  const sponsorship = run.sponsorships[0];
  const ready = await must(builder, "list_products", { developer_ready: true, limit: 100 });
  const isReady = ready.products.some((p) => p.id === PRODUCT);
  note(`Sponsored in ${sponsorship.jurisdictions.join(", ")} under ${sponsorship.licences.join(", ")}; developer-ready: ${isReady ? "yes" : "no"}.`);
  result(2, "Product sponsored and published", `${PRODUCT} sponsored in ${sponsorship.jurisdictions.join(", ")}, developer-ready: ${isReady}`, isReady);

  // ---- 3 ----
  step(3, "Rails and identity: the provider proposes, an admin approves");
  // The identity and transfer partner: a vendor firm with a (placeholder) FinCEN registration, its services listed.
  const vendorUser = await store.upsertClerkUser("demo_vendor", "partner-ops@example.com", "Demo partner", ["vendor"]);
  const vendorFirm = await must(admin, "register_firm", { name: VENDOR_NAME, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-de" } });
  await must(admin, "add_entity_member", { email: "partner-ops@example.com", entity_id: vendorFirm.id });
  vendorUser.entity_id = vendorFirm.id;
  const vendor = await session(vendorUser);
  const msb = await must(vendor, "register_license", { region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "PLACEHOLDER-FINCEN-MSB-000001" });
  await must(admin, "review_license", { license_record_id: msb.id, decision: "verified", note: "Placeholder licence for the demo" });
  // The ramp service types are Mynt's own ramp: an admin names the firm that operates it.
  await must(admin, "set_mynt_ramp", { entity_id: vendorFirm.id });
  const offerings = {};
  for (const key of ["identity_verification", "onramp_quote", "onramp_transfer", "offramp_quote", "offramp_transfer"]) {
    const o = await must(vendor, "create_vendor_offering", { region: "US", service_type: key, name: `${key} (placeholder)`, price: { amount: 0, currency: "USD" }, test_base_url: `${partner.url}/test`, live_base_url: `${partner.url}/live`, licence_ids: [msb.id] });
    partnerSecrets.add(o.conformance_signing_secret);
    const conf = await must(vendor, "run_conformance", { offering_id: o.id });
    if (!conf.passed) throw new Error(`Conformance of ${key} failed: ${JSON.stringify(conf).slice(0, 600)}`);
    await must(vendor, "update_vendor_offering", { offering_id: o.id, listed: true });
    offerings[key] = o.id;
  }
  note(`'${VENDOR_NAME}' listed identity checks and dollar transfers, each passing Mynt's conformance test.`);

  // The builder subscribes and wires them into its product: version 2.
  const subs = {};
  for (const key of Object.keys(offerings)) {
    subs[key] = await must(builder, "subscribe_vendor_service", { offering_id: offerings[key] });
    partnerSecrets.add((await must(vendor, "reveal_subscription_secret", { subscription_id: subs[key].subscription_id })).signing_secret);
    await must(builder, "set_subscription_live", { subscription_id: subs[key].subscription_id, live: true });
  }
  const current = await must(builder, "get_product_definition", { product_id: PRODUCT });
  const def = structuredClone(current.definition);
  const ACTIONS = [
    ["verify_identity", "identity_verification", "customer_enrolled", "identity_verification"],
    ["get_deposit_quote", "onramp_quote", "transfer_in_confirmed", "fiat_onramp"],
    ["deposit", "onramp_transfer", "transfer_in_confirmed", "fiat_onramp"],
    ["get_payout_quote", "offramp_quote", "transfer_out_confirmed", "fiat_offramp"],
    ["payout", "offramp_transfer", "transfer_out_confirmed", "fiat_offramp"],
  ];
  for (const [id, key, trigger, purpose] of ACTIONS) {
    def.partner_handoffs.push({ _id: id, name: id.replace(/_/g, " "), trigger, sends: { type: "object", required: key === "identity_verification" ? ["full_name", "date_of_birth", "ssn"] : ["full_name", "bank_account_number", "routing_number"] }, returns: { type: "object", required: ["status"] } });
    def.connections.push(
      { _id: `h_${id}`, type: "handoff_to_party", from: { kind: "partner_handoff", id }, to: { kind: "party", id: subs[key].vendor_party_id }, attributes: { sla: "PT1M", consent_purpose: purpose, channel: "api", vendor_subscription_id: subs[key].subscription_id, service_type: key } },
      { _id: `s_${id}`, type: "handoff_serves_component", from: { kind: "partner_handoff", id }, to: { kind: "component", id: "transmission" } },
    );
  }
  await must(builder, "set_product_definition", { product_id: PRODUCT, definition: def, changelog: "Identity checks and dollar transfers through the partner" });
  const tested = await must(builder, "test_product", { id: PRODUCT });
  if (!tested.passed) throw new Error(`test_product failed: ${JSON.stringify(tested.checks.filter((c) => c.status === "fail"))}`);
  await must(builder, "publish_product", { id: PRODUCT });
  note(`The builder wired the partner's services into '${PRODUCT}' and published version ${(await store.getProduct(PRODUCT)).version}.`);

  // Rails: proposed by the licence provider, approved by an admin; New York and California only.
  const rails = {};
  for (const [direction, key] of [["on_ramp", "onramp_transfer"], ["off_ramp", "offramp_transfer"]]) {
    const proposed = await must(provider, "propose_rail", { kind: "ramp_adapter", provider: offerings[key], direction, states: ["us-ny", "us-ca"], per_transfer_limit_cents: 500_000, daily_limit_cents: 2_000_000, note: "Demo rail" });
    rails[direction] = await must(admin, "approve_rail", { rail_id: proposed.id });
    note(`Rail ${direction} in us-ny and us-ca: proposed by the provider, ${rails[direction].status} by an admin (limits ${usd(500_000)} a transfer, ${usd(2_000_000)} a day).`);
  }
  const idp = await must(provider, "approve_identity_provider", { sponsorship_id: sponsorship.id, offering_id: offerings.identity_verification, note: "Its checks name the customer's verified state" });
  note(`The provider accepts '${VENDOR_NAME}' identity checks for its sponsorship${idp.approved_at ? ` (from ${idp.approved_at})` : ""}: only checks made from now on count.`);
  result(3, "Rails and identity provider approved", `on_ramp ${rails.on_ramp.status}, off_ramp ${rails.off_ramp.status}, identity provider accepted`, rails.on_ramp.status === "approved" && rails.off_ramp.status === "approved");

  // ---- 4 ----
  step(4, "Customers: one verified in New York moves money; an unverified one and a Texan are refused");
  note("Mode: live, on this computer. Mynt's chokepoint only refuses live movements (sandbox ones are labelled with what");
  note("it would refuse), so this step runs live against the stand-in partner: nothing real exists to move.");
  const { user: devUser } = await store.createUser("Demo developer", ["developer"]);
  const developer = await session(devUser);
  await must(builder, "set_product_access", { id: PRODUCT, access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: "https://example.com/start" } });
  const app = await must(developer, "create_app", { name: "Dollar transfers (demo)", description: "Send dollars in and out", audience: "US individuals", product_ids: [PRODUCT] });
  await must(developer, "publish_app", { app_id: app.id });
  const apiKey = (await must(developer, "create_api_key", { app_id: app.id, environment: "live", label: "demo" })).key;
  note(`A developer published the app '${app.name}' on it and made a live key.`);
  const customer = async (c) => {
    const s = await rest("POST", "/v1/client_sessions", apiKey, { product_ids: [PRODUCT], scopes: ACTIONS.map((a) => a[0]), customer_ref: c.ref });
    if (s.status !== 201) throw new Error(`client session: ${s.text}`);
    const secret = s.body.client_secret;
    for (const purpose of ["identity_verification", "fiat_onramp", "fiat_offramp"]) await rest("POST", "/v1/client/evidence", secret, { product_id: PRODUCT, type: "consent_given", subject: purpose });
    // Sensitive details (the SSN, the bank account) come from the app's secure fields, the rest as typed.
    const { ssn, bank_account_number, ...typed } = CUSTOMER_FIELDS;
    for (const [source, values] of [["typed", { full_name: c.full_name, ...typed }], ["secure_field", { ssn, bank_account_number }]]) {
      const f = await rest("POST", "/v1/client/fields", secret, { product_id: PRODUCT, source, values });
      if (f.status !== 201) throw new Error(`fields: ${f.text}`);
    }
    const act = (action, extra = {}) => rest("POST", `/v1/client/actions/${action}`, secret, { product_id: PRODUCT, ...extra });
    return { act, verify: () => act("verify_identity"), quote: async (kind, amount) => (await act(kind === "deposit" ? "get_deposit_quote" : "get_payout_quote", { params: { direction: kind === "deposit" ? "in" : "out", amount_usd: amount } })).body?.reference };
  };
  const avery = await customer(CUSTOMERS.verified);
  const verified = await avery.verify();
  note(`Avery (New York): identity check ${verified.body?.status}; the partner verified their home state as us-ny.`);
  const dep = await avery.act("deposit", { quote: await avery.quote("deposit", "250.00") });
  note(`Avery deposits $250.00: HTTP ${dep.status}, ${dep.body?.status ?? dep.body?.error}.`);
  const pay = await avery.act("payout", { quote: await avery.quote("payout", "100.00") });
  note(`Avery takes a $100.00 payout: HTTP ${pay.status}, ${pay.body?.status ?? pay.body?.error}.`);
  const blake = await customer(CUSTOMERS.unverified);
  const blakeCheck = await blake.verify();
  const refusedUnverified = await blake.act("deposit", { quote: await blake.quote("deposit", "50.00") });
  note(`Blake (identity check ${blakeCheck.body?.status}) tries to deposit $50.00: HTTP ${refusedUnverified.status}, ${refusedUnverified.body?.error}: ${refusedUnverified.body?.message}`);
  const casey = await customer(CUSTOMERS.texas);
  const caseyCheck = await casey.verify();
  const refusedState = await casey.act("deposit", { quote: await casey.quote("deposit", "50.00") });
  note(`Casey (identity check ${caseyCheck.body?.status}, home state us-tx) tries to deposit $50.00: HTTP ${refusedState.status}, ${refusedState.body?.error}: ${refusedState.body?.message}`);
  const ledgerRows = (await store.db.query("SELECT direction, amount_cents, status, state, state_source FROM financial_products.money_movements WHERE product_id = $1 ORDER BY created_at", [PRODUCT])).rows;
  for (const r of ledgerRows) note(`ledger: ${r.direction} ${usd(Number(r.amount_cents))} ${r.status} in ${r.state} (state ${r.state_source})`);
  const refusals = (await store.db.query("SELECT details FROM financial_products.audit_log WHERE action = 'money_movement_refused' AND target = $1", [PRODUCT])).rows.map((r) => r.details.code);
  note(`Refusals in the audit log: ${refusals.join(", ")}. The partner was called for ${partnerCalls.filter((c) => c.endpoint === "live" && c.key.endsWith("_transfer")).length} transfers, never for a refused one.`);
  const step4ok = dep.status === 201 && pay.status === 201 && refusedUnverified.body?.error === "state_unverified" && refusedState.body?.error === "state_not_sponsored";
  result(4, "Money moves only for a verified, sponsored customer", `deposit ${dep.body?.status}, payout ${pay.body?.status}; refused: ${refusedUnverified.body?.error}, ${refusedState.body?.error}`, step4ok);

  // ---- 5 ----
  step(5, "A health snapshot: computed, encrypted, co-signed by the provider, anchored and verified");
  const partnerKey = generateKeyPairSync("ed25519");
  const partnerAddress = codec.base58Encode(Buffer.from(partnerKey.publicKey.export({ format: "jwk" }).x, "base64url"));
  const cosign = (fingerprint) => edSign(null, Buffer.from(lib.cosignMessage(Buffer.from(fingerprint, "hex"))), partnerKey.privateKey).toString("hex");
  await must(provider, "register_partner_signing_key", { public_key: partnerAddress });
  note(`The provider registered its own Ed25519 signing key ${partnerAddress} (its private half never reaches Mynt).`);
  const signPending = async () => {
    const signed = [];
    for (const view of await must(provider, "list_product_health", {})) {
      for (const snap of (view.snapshots ?? []).filter((x) => x.status === "pending_signature")) {
        await must(provider, "submit_partner_signature", { product_id: view.product_id, ...(view.pool_id ? { pool_id: view.pool_id } : {}), sequence: snap.sequence, signature: cosign(snap.fingerprint) });
        signed.push(`${view.pool_id ? "pool" : "product"} #${snap.sequence}`);
      }
    }
    return signed;
  };
  // One period: a snapshot, the provider's co-signature, then on chain.
  // The workers run five minutes past the hour; the co-signature lands within the window, and the record goes on chain.
  const period = async () => {
    await health.tick();
    const signed = await signPending();
    clock += 6 * 60_000;
    await health.tick();
    clock += HOUR - 6 * 60_000;
    return signed;
  };
  note(`The partner's books (sandbox): reserves ${usd(books.reserves)}, owed to customers ${usd(books.owed)}.`);
  const signed1 = await period();
  const answer = await must(provider, "get_product_health", { product_id: PRODUCT, limit: 5 });
  const latest = answer.latest;
  note(`Snapshot #${latest.sequence} for ${latest.report.period_start} to ${latest.report.period_end}: source ${latest.report.source}, coverage ${latest.report.figures.coverage_bps?.value != null ? pct(latest.report.figures.coverage_bps.value) : "n/a"}.`);
  note(`Encrypted at rest; fingerprint ${latest.fingerprint.slice(0, 16)}...; co-signed: ${signed1.join(", ")}; on chain: ${latest.on_chain ? `yes (${latest.tx_signature})` : "no"}.`);
  const answerFile = join(dir, "health-answer.json");
  writeFileSync(answerFile, JSON.stringify(answer, null, 2));
  const verifier = await new Promise((resolve) =>
    execFile(process.execPath, [fileURLToPath(new URL("scripts/product-health-verify.mjs", ROOT)), "--file", answerFile, "--rpc", rpcUrl, "--program-id", chain.programId, "--partner-key", partnerAddress], { timeout: 120_000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout + stderr })),
  );
  for (const line of verifier.stdout.trim().split("\n")) note(`verify: ${line}`);
  result(5, "Snapshot co-signed, anchored, verified independently", `#${latest.sequence} ${latest.report.source}, on chain ${latest.on_chain ? "yes" : "no"}, verifier exit ${verifier.code}${/OVERALL PASS/.test(verifier.stdout) ? " (OVERALL PASS)" : ""}`, verifier.code === 0 && /OVERALL PASS/.test(verifier.stdout));

  // ---- 6 ----
  step(6, "A covenant: the provider's rule trips on a later snapshot and the alert reaches its webhook");
  const hook = await must(provider, "create_firm_webhook", { url: `${receiver.url}/mynt`, events: ["covenant.breached", "covenant.cleared"] });
  hookSecret = hook.secret;
  const rule = await must(provider, "set_covenant", { sponsorship_id: sponsorship.id, rule_type: "coverage_below", threshold: 10_000, action: "alert" });
  note(`The provider set: alert when coverage (reserves / owed) is below ${pct(rule.threshold)}; its webhook is the local receiver.`);
  books.reserves = 95_000_00;
  note(`Next period the partner's books say reserves ${usd(books.reserves)} against ${usd(books.owed)} owed (95%).`);
  await period();
  const [breach] = await must(provider, "list_covenant_breaches", {});
  note(`Breach: ${breach?.rule_type}, observed ${breach?.observed != null ? pct(breach.observed) : "?"} against ${pct(breach?.threshold ?? 0)}, snapshot #${breach?.snapshot?.sequence}, action ${breach?.action_taken}.`);
  const delivered = await deliverDueWebhooks(store);
  const got = hooks.find((h) => h.body?.type === "covenant.breached");
  note(`Webhook: ${delivered.delivered} delivered; received ${got ? `${got.body.type} for ${got.body.data?.product_id}, sandbox ${got.body.sandbox ?? got.body.data?.sandbox}, signature ${got.signature_valid ? "valid" : "INVALID"}` : "nothing"}.`);
  result(6, "Covenant breach alerted to the provider's webhook", got ? `${got.body.type} received, signature ${got.signature_valid ? "valid" : "invalid"}` : "no alert received", !!got && got.signature_valid);

  // ---- 7 ----
  step(7, "A liquidity provider funds a pool, is paid within the reserve rule, and a withdrawal that would breach it waits");
  books.reserves = 120_000_00;
  const poolRails = {};
  for (const direction of ["deposit", "payout"]) {
    const proposed = await must(provider, "propose_rail", { kind: "ach", provider: "demo-bank-placeholder", direction, states: ["us-ny", "us-ca"], per_transfer_limit_cents: 10_000_000, daily_limit_cents: 50_000_000, note: "Demo pool rail" });
    poolRails[direction] = await must(admin, "approve_rail", { rail_id: proposed.id });
  }
  const pool = await must(builder, "create_pool", { product_id: PRODUCT, component_key: "transmission", name: "Demo liquidity pool (sandbox)", sandbox: true, min_reserve_bps: 10_000, min_reserve_floor_cents: 0, notice_period_days: 0, min_commitment_cents: 1, max_commitment_cents: 10_000_000 });
  await must(provider, "approve_pool", { pool_id: pool.id, deposit_rail_id: poolRails.deposit.id, withdrawal_rail_id: poolRails.payout.id });
  const cleared = await admin("set_pool_offering_cleared", { pool_id: pool.id, cleared: true, legal_basis: "Sandbox pool for the partner demo: no securities are offered" });
  note(`Pool '${pool.name}' (sandbox, reserve at least 100% of what's owed) approved by the provider; offering cleared by an admin: ${cleared.isError ? `refused (${cleared.data.error})` : "yes"}.`);
  const fundUser = await store.upsertClerkUser("demo_fund", "fund@example.com", "Demo fund", ["liquidity_provider"]);
  const fundFirm = await must(admin, "register_firm", { name: FUND_NAME, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ny" } });
  await must(admin, "add_entity_member", { email: "fund@example.com", entity_id: fundFirm.id });
  fundUser.entity_id = fundFirm.id;
  const fund = await session(fundUser);
  const commit = await must(fund, "commit_to_pool", { pool_id: pool.id, amount_cents: 5_000_000, state: "us-ny", idempotency_key: `demo-commit-${randomUUID()}` });
  await must(provider, "report_pool_movement", { movement_id: commit.movement_id, outcome: "settled", external_ref: "demo-ach-in-1" });
  note(`'${FUND_NAME}' committed ${usd(5_000_000)}; the provider reported it settled.`);
  note(`This period the books say reserves ${usd(books.reserves)} against ${usd(books.owed)} owed: ${usd(books.reserves - books.owed)} of headroom over the reserve.`);
  await period();
  const w1 = await must(fund, "request_withdrawal", { pool_id: pool.id, amount_cents: 2_000_000, idempotency_key: `demo-out-${randomUUID()}` });
  await pools.tick();
  const paying = (await must(fund, "list_withdrawals", { pool_id: pool.id })).find((w) => w.id === w1.id);
  const claim = (await store.db.query("SELECT movement_id FROM financial_products.pool_movement_states WHERE withdrawal_id = $1", [w1.id])).rows[0];
  if (claim?.movement_id) await must(provider, "report_pool_movement", { movement_id: claim.movement_id, outcome: "settled", external_ref: "demo-ach-out-1" });
  await pools.tick();
  const paid = (await must(fund, "list_withdrawals", { pool_id: pool.id })).find((w) => w.id === w1.id);
  note(`Withdrawal of ${usd(2_000_000)}: ${paying?.status} then ${paid?.status} (settled ${usd(Number(paid?.settled_cents ?? 0))}).`);
  const w2 = await must(fund, "request_withdrawal", { pool_id: pool.id, amount_cents: 1_000_000, idempotency_key: `demo-out-${randomUUID()}` });
  await pools.tick();
  const held = (await must(fund, "list_withdrawals", { pool_id: pool.id })).find((w) => w.id === w2.id);
  const poolRow = (await must(admin, "list_pools", {})).find((p) => p.id === pool.id);
  note(`A second withdrawal of ${usd(1_000_000)}: ${held?.status}${held?.waiting_reason ? `: ${held.waiting_reason}` : ""}${poolRow?.hold_reason ? ` (pool: ${poolRow.hold_reason})` : ""}.`);
  const heldOk = held?.status === "queued" && Number(held?.settled_cents ?? 0) === 0;
  result(7, "Pool pays within the reserve, holds what would breach it", `first ${paid?.status}, second ${held?.status}`, paid?.status === "paid" && heldOk);

  return { product_id: PRODUCT, program_id: chain.programId, devnet: !!devnet };
}

// ---- command line ----
function loadKeypair(Keypair, path, what) {
  if (!path || !existsSync(path)) throw new Error(`${what}: no keypair file at ${path}`);
  return Keypair.fromSecret(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const { values } = parseArgs({
    options: {
      devnet: { type: "boolean", default: false },
      rpc: { type: "string", default: "https://api.devnet.solana.com" },
      "program-id": { type: "string" },
      "publisher-key": { type: "string" },
      "funding-key": { type: "string" },
      keep: { type: "boolean", default: false },
      "cleanup-only": { type: "boolean", default: false },
      dir: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  if (values["cleanup-only"]) {
    const target = values.dir;
    if (!target || !target.split(/[\\/]/).pop().startsWith(DIR_PREFIX) || !existsSync(target)) {
      console.error(`--cleanup-only needs --dir <a folder named ${DIR_PREFIX}… that a --keep run printed>`);
      return 2;
    }
    rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${target}.`);
    return 0;
  }
  // A demo key of its own, whatever the shell has loaded: nothing sealed here is readable by any real server.
  process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");
  let devnet = null;
  if (values.devnet) {
    const { Keypair } = await import(new URL("dist/solana/codec.js", ROOT).href);
    if (!values["program-id"]) throw new Error("--devnet needs --program-id (the product-health program you deployed on devnet)");
    devnet = { rpc: values.rpc, programId: values["program-id"], publisherKey: loadKeypair(Keypair, values["publisher-key"], "--publisher-key"), fundingKey: values["funding-key"] ? loadKeypair(Keypair, values["funding-key"], "--funding-key") : null };
  }
  const out = await runPartnerWalkthrough({ devnet, keep: values.keep });
  return out.passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`\nThe walkthrough stopped: ${e.message}`);
      process.exit(1);
    },
  );
}
