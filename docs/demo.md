# The partner walkthrough

A scripted, repeatable run of Mynt's whole story, for showing a prospective licence partner in a meeting and for
proving that the pieces work together. It runs entirely on your own computer: nothing goes to Mynt's servers, no
real company is named, and no money exists anywhere in it.

## Before the meeting

You need a copy of this repository and Node.js 22 or newer.

1. Open a terminal in the repository's `core` folder (the server).
2. Install and build (once, takes a minute or two):

   ```
   npm ci && npm run build
   ```

3. Do a practice run, so you know what the screen will show:

   ```
   npm run demo:partner
   ```

It takes a minute or two and prints seven numbered steps, a summary table and a "Cleaned up" list. Every row of
the summary should say PASS.

## What it uses

- **A throwaway Mynt.** The real Mynt server code, started inside the script with an in-memory database, the same
  way Mynt's own tests run. It is created fresh for every run and removed at the end.
- **Placeholders.** "Example Money Transmitter (placeholder)" is not a real firm; its LEI and licence numbers are
  made up and say so. The customers (Avery, Blake and Casey) are made up too.
- **Stand-ins for everyone outside Mynt.** The public registers (GLEIF and FinCEN), the identity and bank-transfer
  partner, the partner's webhook and (by default) the blockchain are small programs on your computer that answer
  the way the real ones do.
- **Sandbox books.** The licence provider's reserve figures are test numbers the script sets as the story goes.

## What each step shows

1. **An admin adds the licence provider, and Mynt checks it's a real company.** Mynt itself looks the firm up in
   GLEIF's register of legal entities and FinCEN's list of money services businesses, and keeps each answer with
   where it came from and a fingerprint of it. Until the firm passes, it can't sponsor anything.
2. **A builder makes a money-transmission product; the provider sponsors it.** The builder holds no licence. The
   licence provider sponsors the product in New York and California under its state licences, and the product
   becomes available to developers.
3. **Rails and identity.** The licence provider proposes the routes money may take (in and out, New York and
   California only, with limits per transfer and per day) and a Mynt admin approves them. The provider also names
   the identity-check provider it trusts to say which state a customer lives in.
4. **Customers.** Avery passes an identity check that says she lives in New York; she deposits $250 and takes a $100
   payout. Blake's identity check fails, so his deposit is refused. Casey is verified but lives in Texas, where the
   product isn't sponsored, so hers is refused too. The refused ones never reach the partner. This step runs Mynt's
   checks in **live mode on your computer**: Mynt only *refuses* live transfers (in sandbox mode it labels what it
   would have refused, and lets developers test), and here every partner is a local stand-in, so nothing real moves.
5. **A health snapshot.** Mynt computes the product's financial health from the licence provider's books (reserves
   against what's owed to customers), encrypts it so only the provider can read it, waits for the provider to
   co-sign it with its own key, and records its fingerprint on a blockchain. Then a separate, standalone checker
   (`core/scripts/product-health-verify.mjs`, which uses nothing from Mynt) confirms the record: "OVERALL PASS".
6. **A covenant.** The provider sets a rule: tell us when reserves fall below 100% of what's owed. A rule on a live
   product is judged on the provider's own books, never on sandbox figures, so the provider first connects them with
   the [partner kit](partners.md)'s fallback for a firm without an API: it registers a test key, uploads a signed test
   file, passes conformance, uploads today's live file signed with its live key, and switches its ledger to it. The
   next period's books show 95%, the rule trips on those real (stand-in) books, and the alert arrives at the
   provider's own webhook, signed so it can tell it came from Mynt. (On a real server a new member of a licence
   provider waits 72 hours before it can connect the firm's books; the demo's accounts are a minute old, so it turns
   that wait off and says so.)
7. **A liquidity pool.** The provider uploads the day's new file. A liquidity provider puts $50,000 into a pool backing the product. An admin records that the
   offering was cleared. The provider asks for $20,000 back and is paid, because the reserve stays above its minimum.
   A second request for $10,000 would take the reserve below its minimum, so it waits in the queue for a healthier
   snapshot instead of being paid.

## Leaving nothing behind

By default the run removes everything it made: the database, its working folder, the stand-in programs and the
local servers, even if it stops with an error or you press Ctrl-C. The "Cleaned up" list at the end says what was
removed, and anything that couldn't be.

To look around afterwards, add `--keep`:

```
npm run demo:partner -- --keep
```

It keeps the database and files in a folder it names, and prints the command that removes them later:

```
npm run demo:partner -- --cleanup-only --dir <the folder it printed>
```

## On Solana devnet (optional)

By default the blockchain is a stand-in that enforces the same rules as Mynt's product-health program. With
`--devnet` the snapshots are recorded on Solana's public test network instead. That needs a product-health program
deployed on devnet for demos, and the key file its configuration names as the publisher. It never uses production
keys, and refuses any network that isn't devnet.

```
npm run demo:partner -- --devnet --program-id <program address> --publisher-key <publisher-keypair.json> --funding-key <devnet-funding-keypair.json>
```

- `--funding-key` (optional) tops up the publisher with 0.02 devnet SOL if it's low, and at the end sends what's
  left back to the funding key.
- `--rpc` (optional) uses another devnet RPC address instead of the public one.
- What can't be cleaned up is listed with its address: each product's record on chain (its "head" account) stays,
  because the program deliberately has no way to delete a record. Your key files are yours and are never deleted.

## If something goes wrong

The summary marks the failing step FAIL and the line after "The walkthrough stopped" says why. The run still cleans
up after itself. Run it again: every run starts from nothing.
