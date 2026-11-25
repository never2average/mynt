# The partner walkthrough

This file is for whoever presents Mynt to a prospective licence provider. It is a scripted, repeatable run of Mynt's whole flow, for showing in a meeting and for proving that the pieces work together.

It runs entirely on your own computer: nothing goes to Mynt's servers, no real company is named, and no money exists anywhere in it.

## Before the meeting

You need a copy of this repository and Node.js 22.13 or newer.

1. Open a terminal in the repository's `core` folder (the server).
2. Install and build (once, takes a minute or two):

   ```sh
   npm ci && npm run build
   ```

3. Do a practice run, so you know what the screen will show:

   ```sh
   npm run demo:partner
   ```

It takes a minute or two and prints seven numbered steps, a summary table and a "Cleaned up" list. Every row of the summary should say PASS.

## What it uses

- **A throwaway Mynt.** The real Mynt server code, started inside the script with an in-memory database, the same way Mynt's own tests run. It is created fresh for every run and removed at the end.
- **Placeholders.** "Example Money Transmitter (placeholder)" is the licence provider in the run. It is not a real firm; its legal entity identifier and licence numbers are made up and say so. The customers (Avery, Blake and Casey) are made up too.
- **Stand-ins for everyone outside Mynt.** The public registers (GLEIF and FinCEN), the identity and bank-transfer partner, the licence provider's webhook and (by default) the blockchain are small programs on your computer that answer the way the real ones do.
- **Sandbox books.** The licence provider's reserve figures are test numbers the script sets as the run goes.

## What each step shows

### Step 1: an admin adds the licence provider, and Mynt checks it is a real company

Mynt itself looks the firm up in GLEIF's register of legal entities and FinCEN's list of money services businesses, and keeps each answer with where it came from and a fingerprint of it. Until the firm passes, it can't sponsor anything.

### Step 2: a builder makes a money-transmission product, and the licence provider sponsors it

The builder holds no licence. The licence provider sponsors the product in New York and California under its state licences, and the product becomes available to builders' apps.

### Step 3: rails and identity

The licence provider proposes the routes money may take (in and out, New York and California only, with limits per transfer and per day) and a Mynt admin approves them. The licence provider also names the identity-check service it trusts to say which state a customer lives in.

### Step 4: customers

- Avery passes an identity check that says they live in New York. They deposit $250 and take a $100 payout.
- Blake's identity check fails, so their deposit is refused.
- Casey is verified but lives in Texas, where the product isn't sponsored, so their deposit is refused too.

The refused ones never reach the bank-transfer partner.

This step runs Mynt's checks in **live mode on your computer**. Mynt only refuses live transfers; in sandbox mode it labels what it would have refused, and lets builders test. Here every outside party is a local stand-in, so nothing real moves.

### Step 5: a health snapshot

A health snapshot is the periodic record of a product's financial health.

1. Mynt computes it from the licence provider's books: reserves against what is owed to customers.
2. Mynt encrypts it so only the licence provider can read it.
3. Mynt waits for the licence provider to co-sign it, which means signing the same snapshot with its own key to say it agrees with the figures.
4. Mynt records the snapshot's fingerprint on a blockchain.
5. A separate, standalone checker (`core/scripts/product-health-verify.mjs`, which uses nothing from Mynt) confirms the record: "OVERALL PASS".

### Step 6: a covenant

A covenant is a rule a licence provider sets on a product it sponsors. Here the rule is: tell us when reserves fall below 100% of what is owed.

A rule on a live product is judged on the licence provider's own books, never on sandbox figures. So the licence provider first connects its books, with the [partner kit](partners.md)'s fallback for a firm without an API:

1. It registers a test key.
2. It uploads a signed test file.
3. It passes conformance, which is Mynt's test of the firm's integration: the firm runs it and sees pass or fail, case by case.
4. It uploads today's live file, signed with its live key.
5. It switches its ledger to the file.

Then the rule trips:

1. The next period's books show 95%.
2. The rule trips on those real (stand-in) books.
3. The alert arrives at the licence provider's own webhook, signed so the firm can tell it came from Mynt.

On a real server a new member of a licence provider waits 72 hours before they can connect the firm's books. The walkthrough's accounts are a minute old, so it turns that wait off and says so.

### Step 7: a liquidity pool

A liquidity pool is capital that liquidity providers commit to a product.

1. The licence provider uploads the day's new file.
2. The builder creates a pool backing the product, the licence provider approves it, and a Mynt admin records that the offering was cleared.
3. A liquidity provider puts $50,000 into the pool.
4. The liquidity provider asks for $20,000 back and is paid, because the reserve stays above its minimum.
5. A second request for $10,000 would take the reserve below its minimum, so it waits in the queue for a healthier snapshot instead of being paid.

## Leaving nothing behind

By default the run removes everything it made: the database, its working folder, the stand-in programs and the local servers, even if it stops with an error or you press Ctrl-C. The "Cleaned up" list at the end says what was removed, and anything that couldn't be.

To look around afterwards, add `--keep`:

```sh
npm run demo:partner -- --keep
```

It keeps the database and files in a folder it names, and prints the command that removes them later:

```sh
npm run demo:partner -- --cleanup-only --dir <the folder it printed>
```

## On Solana devnet (optional)

By default the blockchain is a stand-in that enforces the same rules as Mynt's product-health program. With `--devnet` the snapshots are recorded on Solana's public test network instead. That needs a product-health program deployed on devnet for demonstrations, and the key file its configuration names as the publisher. It never uses production keys, and refuses any network that isn't devnet.

```sh
npm run demo:partner -- --devnet --program-id <program address> --publisher-key <publisher-keypair.json> --funding-key <devnet-funding-keypair.json>
```

- `--funding-key` (optional) tops up the publisher with 0.02 devnet SOL if it is low, and at the end sends what is left back to the funding key.
- `--rpc` (optional) uses another devnet RPC address instead of the public one.
- What can't be cleaned up is listed with its address: each product's record on chain (its "head" account) stays, because the program deliberately has no way to delete a record. Your key files are yours and are never deleted.

## If something goes wrong

The summary marks the failing step FAIL and the line that starts "The walkthrough stopped" says why. The run still cleans up after itself. Run it again: every run starts from nothing.
