import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { ClerkIdentityProvider, clerkAccountPortalUrl } from "../dist/auth.js";
import { LinkedAccountsService, chainOf } from "../dist/linked-accounts.js";
import { CATALOG } from "./helpers.js";

const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const ETH = "0x52908400098527886E0F7030069857D2E4169EE7";
const PK = `pk_test_${Buffer.from("happy-otter-12.clerk.accounts.dev$").toString("base64")}`;
const MANAGE = "https://happy-otter-12.accounts.dev/user";

// Clerk's backend as the adapter reads it: a user with whatever linked accounts the test gives, and fields the
// adapter must never pass on.
function fakeClerk(users, { fail = null } = {}) {
  const c = {
    calls: 0,
    fail,
    users: {
      async getUser(id) {
        c.calls++;
        if (c.fail) throw Object.assign(new Error("upstream detail sk_live_leak"), { status: c.fail });
        return users[id] ?? { externalAccounts: [], web3Wallets: [] };
      },
    },
  };
  return c;
}
const github = (username, status = "verified") => ({ provider: "oauth_github", username, verification: { status }, approvedScopes: "repo", token: "gho_never_returned" });
const wallet = (address, status = "verified") => ({ web3Wallet: address, verification: { status } });

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (clerkId) => {
    const { user } = await store.createUser("Ana", ["consumer"]);
    if (clerkId) await pg.query("UPDATE financial_products.users SET clerk_user_id = $2 WHERE id = $1", [user.id, clerkId]);
    return user;
  };
  const connect = async (user, identity) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, identity ? { identity } : {}).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const linked = async (user, identity) => JSON.parse((await (await connect(user, identity)).callTool({ name: "get_linked_accounts", arguments: {} })).content[0].text);
  return { store, as, connect, linked };
}
const service = (store, clerk, ...rest) => new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, store.db, clerk), ...rest);

test("linked accounts: none, GitHub only, a Solana wallet, both; verified ones only; never a token", async () => {
  const w = await world();
  const clerk = fakeClerk({
    u_none: { externalAccounts: [], web3Wallets: [] },
    u_gh: { externalAccounts: [github("octo"), { provider: "oauth_google", username: "x", verification: { status: "verified" } }], web3Wallets: [] },
    u_sol: { externalAccounts: [], web3Wallets: [wallet(SOL)] },
    u_both: {
      externalAccounts: [github("unverified-octo", "unverified"), github("octo")],
      web3Wallets: [wallet(SOL), wallet(ETH, "unverified"), wallet("not-an-address")],
    },
  });
  const s = service(w.store, clerk);
  assert.deepEqual(await w.linked(await w.as("u_none"), s), { git: null, wallets: [], manage_url: MANAGE });
  assert.deepEqual(await w.linked(await w.as("u_gh"), s), { git: { provider: "github", username: "octo", verified: true }, wallets: [], manage_url: MANAGE });
  assert.deepEqual(await w.linked(await w.as("u_sol"), s), { git: null, wallets: [{ chain: "solana", address: SOL, verified: true }], manage_url: MANAGE });
  const both = await w.linked(await w.as("u_both"), s);
  assert.deepEqual(both, {
    git: { provider: "github", username: "octo", verified: true },
    wallets: [{ chain: "solana", address: SOL, verified: true }],
    manage_url: MANAGE,
  }, "the verified GitHub account preferred; an unverified wallet left out");
  assert.ok(!JSON.stringify(both).includes("gho_") && !JSON.stringify(both).includes("approvedScopes"), "never a token or scope");
});

test("linked accounts: answers cached a minute, failures 15 seconds; a deleted account said so; never the provider's message", async () => {
  const w = await world();
  let now = 0;
  const clerk = fakeClerk({ u: { externalAccounts: [github("octo")], web3Wallets: [] } });
  const s = service(w.store, clerk, 60_000, () => now, 15_000);
  const u = await w.as("u");
  await s.forUser(u.id);
  await s.forUser(u.id);
  assert.equal(clerk.calls, 1);
  now = 61_000;
  await s.forUser(u.id);
  assert.equal(clerk.calls, 2);

  // Down: null with a reason, cached briefly.
  const down = fakeClerk({}, { fail: 503 });
  let t = 0;
  const ds = service(w.store, down, 60_000, () => t, 15_000);
  const r = await ds.forUser(u.id);
  assert.equal(r.git, null);
  assert.equal(r.wallets, null, "unknown, not none");
  assert.match(r.unavailable, /couldn't be reached \(HTTP 503\)/);
  assert.ok(!JSON.stringify(r).includes("sk_live_leak"));
  assert.equal(r.manage_url, MANAGE);
  await ds.forUser(u.id);
  assert.equal(down.calls, 1, "a failure is cached too");
  t = 16_000;
  down.fail = null;
  assert.equal((await ds.forUser(u.id)).wallets.length, 0, "and asked again after 15 seconds");
  // The account was deleted at the provider.
  const gone = await service(w.store, fakeClerk({}, { fail: 404 })).forUser(u.id);
  assert.match(gone.unavailable, /no account for you any more/);
  // Someone who didn't sign in through the provider (a local token).
  assert.match((await w.linked(await w.as(null), service(w.store, fakeClerk({})))).unavailable, /didn't sign in through the identity provider/);
});

test("the tool is there when an identity provider is configured, and only then", async () => {
  const w = await world();
  const u = await w.as("u");
  const names = async (identity) => (await (await w.connect(u, identity)).listTools()).tools.map((t) => t.name);
  assert.ok((await names(service(w.store, fakeClerk({})))).includes("get_linked_accounts"));
  assert.ok(!(await names(null)).includes("get_linked_accounts"));
});

test("the account page and wallet chains", () => {
  assert.equal(clerkAccountPortalUrl("happy-otter-12.clerk.accounts.dev"), MANAGE);
  assert.equal(clerkAccountPortalUrl("clerk.example.com"), "https://accounts.example.com/user");
  assert.equal(clerkAccountPortalUrl("auth.example.com"), null, "a host Mynt can't map: no guess");
  assert.equal(clerkAccountPortalUrl("clerk.example.com", "https://id.example.com/user"), "https://id.example.com/user");
  for (const bad of ["http://id.example.com/user", "not a url", "https://u:p@id.example.com/user"])
    assert.throws(() => clerkAccountPortalUrl("clerk.example.com", bad), /must be a valid https URL/, bad);
  assert.equal(chainOf(ETH), "ethereum");
  assert.equal(chainOf(SOL), "solana");
  assert.equal(chainOf("0x123"), null);
  assert.equal(chainOf("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"), null, "a Bitcoin address isn't shown as either");
});
