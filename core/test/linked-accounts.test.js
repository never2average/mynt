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

// Clerk's backend as the adapter reads it: a user with whatever linked accounts the test gives, and fields the
// adapter must never pass on.
function fakeClerk(users, { fail = null } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    users: {
      async getUser(id) {
        calls++;
        if (fail) throw Object.assign(new Error("upstream detail sk_live_leak"), { status: fail });
        return users[id] ?? { externalAccounts: [], web3Wallets: [] };
      },
    },
  };
}
const github = (username, status = "verified") => ({ provider: "oauth_github", username, verification: { status }, approvedScopes: "repo", token: "gho_never_returned" });
const wallet = (address, status = "verified") => ({ web3Wallet: address, verification: { status } });

async function connect(identity, clerkId = "user_1") {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Ana", ["consumer"]);
  if (clerkId) await pg.query("UPDATE financial_products.users SET clerk_user_id = $2 WHERE id = $1", [user.id, clerkId]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user, { identity }).connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return async () => JSON.parse((await client.callTool({ name: "get_linked_accounts", arguments: {} })).content[0].text);
}

test("linked accounts: none, GitHub only, a Solana wallet, both; never a token", async () => {
  const clerk = fakeClerk({
    u_none: { externalAccounts: [], web3Wallets: [] },
    u_gh: { externalAccounts: [github("octo"), { provider: "oauth_google", username: "x" }], web3Wallets: [] },
    u_sol: { externalAccounts: [], web3Wallets: [wallet(SOL)] },
    u_both: { externalAccounts: [github("octo", "unverified")], web3Wallets: [wallet(SOL), wallet(ETH, "unverified"), wallet("not-an-address")] },
  });
  const service = new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, clerk));
  const manage_url = "https://happy-otter-12.accounts.dev/user";
  assert.deepEqual(await (await connect(service, "u_none"))(), { git: null, wallets: [], manage_url });
  assert.deepEqual(await (await connect(service, "u_gh"))(), { git: { provider: "github", username: "octo", verified: true }, wallets: [], manage_url });
  assert.deepEqual(await (await connect(service, "u_sol"))(), { git: null, wallets: [{ chain: "solana", address: SOL, verified: true }], manage_url });
  const both = await (await connect(service, "u_both"))();
  assert.deepEqual(both, {
    git: { provider: "github", username: "octo", verified: false },
    wallets: [
      { chain: "solana", address: SOL, verified: true },
      { chain: "ethereum", address: ETH, verified: false },
    ],
    manage_url,
  });
  assert.ok(!JSON.stringify(both).includes("gho_") && !JSON.stringify(both).includes("approvedScopes"), "never a token or scope");
});

test("linked accounts: cached for a minute per user; an unreachable provider is null with a reason, never a crash or its message", async () => {
  let now = 0;
  const clerk = fakeClerk({ u: { externalAccounts: [github("octo")], web3Wallets: [] } });
  const service = new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, clerk), 60_000, () => now);
  await service.forSubject("u");
  await service.forSubject("u");
  assert.equal(clerk.calls, 1, "the second read is the cache's");
  now = 61_000;
  await service.forSubject("u");
  assert.equal(clerk.calls, 2, "read again after a minute");

  const down = new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, fakeClerk({}, { fail: 503 })));
  const r = await (await connect(down, "u"))();
  assert.equal(r.git, null);
  assert.equal(r.wallets, null, "unknown, not none");
  assert.match(r.unavailable, /couldn't be reached \(HTTP 503\)/);
  assert.ok(!JSON.stringify(r).includes("sk_live_leak"), "the provider's own message isn't passed on");
  assert.equal(r.manage_url, "https://happy-otter-12.accounts.dev/user");
  // Someone who didn't sign in through the provider (a local token).
  const local = await (await connect(new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, fakeClerk({}))), null))();
  assert.match(local.unavailable, /didn't sign in through the identity provider/);
});

test("the account page and wallet chains", () => {
  assert.equal(clerkAccountPortalUrl("happy-otter-12.clerk.accounts.dev"), "https://happy-otter-12.accounts.dev/user");
  assert.equal(clerkAccountPortalUrl("clerk.example.com"), "https://accounts.example.com/user");
  assert.equal(clerkAccountPortalUrl("auth.example.com"), null, "a host Mynt can't map: no guess");
  assert.equal(clerkAccountPortalUrl("clerk.example.com", "https://id.example.com/user"), "https://id.example.com/user");
  assert.equal(chainOf(ETH), "ethereum");
  assert.equal(chainOf(SOL), "solana");
  assert.equal(chainOf("0x123"), null);
  assert.equal(chainOf("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"), null, "a Bitcoin address isn't shown as either");
});
