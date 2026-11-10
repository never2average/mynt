# Connecting a licence provider to Mynt

This guide is for the engineers at a licensed firm (a bank, a money transmitter) that sponsors products built on Mynt. It says what Mynt needs from your systems, how to send it, and how to see for yourself that it works before anything goes live. Mynt tests your integration the way it tests vendors: you run the tests, you see pass or fail, case by case.

Addresses in this guide are placeholders. `https://ledger.partner.example` stands for your own host, and `<MYNT>` for the Mynt server your contact at Mynt gives you.

## What Mynt needs from you

| | What | Why | How you provide it |
|---|---|---|---|
| (a) | **Your ledger**: for each product you sponsor, the funds you hold for it and what you owe its customers, as of a time you state, signed with your firm's key | Product health: you and your liquidity providers watch every product's reserves against its obligations, from your books and never from the developer's app | An HTTPS endpoint Mynt calls (preferred), or a signed file you upload once a day |
| (b) | **The customer's verified home state**, from the identity checks you accept | A live money movement goes only by the US state a licensed partner verified | An identity service you offer, or one you approve, returns `residential_state` on a passed check |
| (c) | **Money rails** | Money moves only through rails an admin approved, within your licences | A ramp adapter in front of your API, or Mynt's wire contract |

(b) and (c) are already part of Mynt (see "Partner requirements" and "Approved money rails" in [reference.md](reference.md)). This kit adds (a) and one test, `run_partner_conformance`, that checks all three.

**Until you connect (a), your products' health snapshots come from Mynt's sandbox ledger**: made-up figures marked `source: sandbox`, which never count as live, whatever else is true.

## Before you start

You need a Mynt account with the licence-provider role at your firm (an admin at Mynt adds you). Then:

1. **Your firm id.** `get_my_entity` shows it (`id`). It goes in every statement as `provider_entity_id`.
2. **Two signing keys.** Make two Ed25519 key pairs in your own key store; the private keys never leave you.
   - Your **live key** signs your real books. Register its public key, base58 encoded (the same form as a Solana address), with `register_partner_signing_key`. It's the same key you co-sign product-health snapshots with.
   - Your **test key** signs your test books only. Register it with `register_partner_test_signing_key`. It must be a different key.

   A statement signed with the test key is never accepted as live, and one signed with the live key is never accepted as test. Keep the live private key out of your test deployment altogether.
3. **Your endpoints** (for the HTTPS feed). Tell your Mynt contact your test and live URLs, for example `https://ledger-test.partner.example` and `https://ledger.partner.example`. Each must be an origin and a path only (no query string, no fragment), HTTPS on port 443, on a public address, and different from the other. An admin proposes them with `configure_partner_ledger`, and **nothing changes until you confirm**: you get a `partner_ledger.endpoint_change_pending` event on your firm's webhooks, `get_partner_kit` shows the proposal under `pending_endpoint_change`, and you check that both URLs are your own deployments before passing them back with `confirm_partner_ledger_endpoints` (or `accept: false` to decline). Confirming a change puts your firm back on the sandbox until you pass conformance again.
4. **Mynt's request secret.** Once your endpoints are confirmed, take the secret Mynt signs its requests with: `reveal_partner_ledger_secret`. It's shown once, to your firm's own people only (admins never see it). Keep it in your secrets store. `rotate_partner_ledger_secret` replaces it.

**Changes to your books' connection wait, and are told.** A member who joined your firm in the last 72 hours can't register or replace keys, confirm endpoints, upload a live file or switch your ledger to live, so an account added to your firm can't quietly take over what Mynt reads as your books. Every one of those changes, and every member an admin adds, goes to your firm's webhooks and to each of your members (`list_firm_notices`). With two or more long-standing members, a live key change or a switch to live waits for a second member's `approve_partner_kit_change`. Act on these notices: they're how you'd see someone else changing your connection.

## (a) The ledger feed over HTTPS

Mynt is the client. It calls your endpoint when it records a product's health (hourly by default) and during conformance. Your test endpoint gets only test requests; your live endpoint only live ones.

### The request

```
POST <your base URL>/v1/ledger
Content-Type: application/json
Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your request secret>
User-Agent: Mynt-Vendor-Client/1

{
  "schema": "mynt.partner_ledger.request.v1",
  "request_id": "8b0f3c2e-5d1a-4e7b-9c41-2f6a0d9e7b13",
  "environment": "live",
  "provider_entity_id": "<your firm id>",
  "product_ids": ["product-a", "product-b"],
  "period_end": "2026-11-10T14:00:00.000Z",
  "audience": "https://ledger.partner.example/v1/ledger"
}
```

Mynt asks once per round for every product you sponsor, so expect one request per hour, not one per product.

Schema: [`schemas/partner-ledger/request.v1.schema.json`](../schemas/partner-ledger/request.v1.schema.json).

**Check every request before you answer it.**

1. Compute the HMAC-SHA256 of the text `<t>.<raw body>` (the timestamp from the header, a dot, then the body exactly as received) with your request secret, and compare it to `v1` in constant time. Refuse with `401` when it doesn't match, or when `t` is more than 300 seconds from your clock. This is the same signing as Mynt's vendor wire contract.
2. **Environment.** Each deployment knows which environment it serves, from its own configuration, never from the request. Refuse with `400` a request whose `environment` isn't that one: your test deployment never answers `"live"`.
3. **Audience.** `audience` is the exact URL Mynt sent the request to. Refuse with `400` unless it's your own endpoint's URL, written exactly as Mynt has it (`<your base URL>/v1/ledger`). The signature covers the body, so this is what stops someone relaying Mynt's request to you from an address of their own and reading your answer.
4. Treat a repeated `request_id` as a replay.

### Your answer: a signed statement

Answer `200` with a statement covering **every** `product_id` in the request:

```json
{
  "schema": "mynt.partner_ledger.v1",
  "provider_entity_id": "<your firm id>",
  "environment": "live",
  "request_id": "8b0f3c2e-5d1a-4e7b-9c41-2f6a0d9e7b13",
  "as_of": "2026-11-10T13:58:12Z",
  "products": [
    { "product_id": "product-a", "reserves_held_cents": 1250000, "customer_obligations_cents": 1000000, "reason": null },
    { "product_id": "product-b", "reserves_held_cents": null, "customer_obligations_cents": 420000, "reason": "Reserve reconciliation for today is still running" }
  ],
  "signature": { "public_key": "<your registered key, base58>", "value": "<128 hex characters>" }
}
```

Schema: [`schemas/partner-ledger/statement.v1.schema.json`](../schemas/partner-ledger/statement.v1.schema.json).

The rules:

- **Money is integer US cents.** `1250000` is $12,500.00. Never a decimal, never a string.
- **Per sponsor, per product.** The figures are your firm's books for that product. If you ring-fence pools, sum them: Mynt treats a sponsor's pools on a product as sharing these reserves.
- **A figure you can't give is `null`, with a `reason`.** Never send `0` in its place: zero means zero. A `null` without a reason is refused.
- **A product you don't recognise** comes back with both figures `null` and a reason (for example `"unknown_product"`). Don't leave it out.
- **`as_of`** is when your books said this, with a time zone. Mynt refuses a time more than 300 seconds in the future (check your clock) or older than 24 hours.
- **`environment`** is your deployment's own, which is the request's (you refused any other). Sign live statements with your live key and test statements with your test key: test figures never stand in for live ones.
- **`request_id`** echoes the request's.

### Signing the statement

Sign with Ed25519, using your registered key for that environment, over these bytes:

1. the UTF-8 text `mynt.partner_ledger.v1`,
2. one zero byte,
3. the **canonical JSON** of the statement without its `signature` member, as UTF-8.

Canonical JSON is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (the JSON Canonicalization Scheme), with integers only: object keys sorted by UTF-16 code unit, no spaces or line breaks, integers written plainly, `null`, `true`, `false`, and strings escaped as `JSON.stringify` escapes them (quotes, backslashes and control characters only; other characters as UTF-8). Any RFC 8785 library produces the same bytes for a statement. Put the 64-byte signature in `signature.value` as lowercase hex and your base58 public key in `signature.public_key`.

### Errors

Any refusal is a `4xx` or `5xx` with a small JSON body ([`schemas/partner-ledger/error.v1.schema.json`](../schemas/partner-ledger/error.v1.schema.json)):

```json
{ "error": { "code": "bad_signature", "message": "Signature mismatch" } }
```

| When | Status | `code` (suggested) |
|---|---|---|
| The signature doesn't verify, or is more than 300 s old | `401` | `bad_signature`, `stale_request` |
| The body isn't the request's shape | `400` | `bad_request` |
| `environment` isn't the one this deployment serves | `400` | `wrong_environment` |
| `audience` isn't this endpoint's own URL | `400` | `wrong_audience` |
| Your systems can't answer just now | `503` | `unavailable` |

Mynt keeps the code, never your message. When a live read fails, that period's snapshot says `source: unavailable` with its figures null, and you'll see it in `list_product_health`; nothing is guessed.

### What Mynt checks on every live read

The same as conformance: the schema, that it's your firm and the live environment, that `request_id` echoes, that the signature verifies with your registered live key (a statement signed with your test key is refused), the clock, and that each null has a reason. A statement that fails any of these isn't used. A product it leaves out is recorded as null, "the partner's statement didn't cover this product".

## A worked example (Node.js)

Your endpoint, in outline. Any language works: these are the only two cryptographic steps. Run it twice, as two separate deployments with their own configuration: a test one with your test key and test books, and a live one with your live key and real books.

```js
import { createHmac, timingSafeEqual, sign } from "node:crypto";

// Fixed per deployment, from its own configuration: never taken from the request.
const ENVIRONMENT = "live"; // "test" in your test deployment
const OWN_URL = "https://ledger.partner.example/v1/ledger"; // this deployment's own URL, exactly as Mynt calls it
const PRIVATE_KEY = loadKey(ENVIRONMENT === "live" ? "ledger-live-key" : "ledger-test-key"); // your key store
const PUBLIC_KEY = ENVIRONMENT === "live" ? "<your live key, base58>" : "<your test key, base58>";

// 1. Verify Mynt's request.
function verifyMynt(header, rawBody, secret) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const want = createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2], "hex"));
}

// 2. Canonical JSON: sorted keys, no spaces, integers only.
function canonical(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error("integers only");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

// 3. Sign the statement with your Ed25519 private key (a KeyObject from your key store).
function signStatement(unsigned, privateKey, publicKeyBase58) {
  const message = Buffer.concat([Buffer.from("mynt.partner_ledger.v1"), Buffer.from([0]), Buffer.from(canonical(unsigned))]);
  return { ...unsigned, signature: { public_key: publicKeyBase58, value: sign(null, message, privateKey).toString("hex") } };
}

// In your handler:
//   if (!verifyMynt(req.headers["mynt-signature"], raw, process.env.MYNT_LEDGER_SECRET)) return 401 { error: { code: "bad_signature", … } }
//   const body = JSON.parse(raw);
//   if (!Array.isArray(body.product_ids)) return 400 { error: { code: "bad_request", … } }
//   if (body.environment !== ENVIRONMENT) return 400 { error: { code: "wrong_environment", … } }
//   if (body.audience !== OWN_URL) return 400 { error: { code: "wrong_audience", … } }
//   const products = body.product_ids.map((id) => yourBooks(id) ?? { product_id: id, reserves_held_cents: null, customer_obligations_cents: null, reason: "unknown_product" });
//   return 200 signStatement({ schema: "mynt.partner_ledger.v1", provider_entity_id: YOUR_FIRM_ID, environment: ENVIRONMENT,
//                              request_id: body.request_id, as_of: new Date().toISOString(), products }, PRIVATE_KEY, PUBLIC_KEY);
```

For the request in the example above, the signed bytes start `mynt.partner_ledger.v1`, a zero byte, then:

```
{"as_of":"2026-11-10T13:58:12Z","environment":"live","products":[{"customer_obligations_cents":1000000,"product_id":"product-a","reason":null,"reserves_held_cents":1250000},{"customer_obligations_cents":420000,"product_id":"product-b","reason":"Reserve reconciliation for today is still running","reserves_held_cents":null}],"provider_entity_id":"<your firm id>","request_id":"8b0f3c2e-5d1a-4e7b-9c41-2f6a0d9e7b13","schema":"mynt.partner_ledger.v1"}
```

## The fallback: a signed daily file

No API? Upload the same statement once a day with `upload_partner_ledger_file` (licence-provider members only; admins can't upload for you). Differences from the feed:

- `request_id` is `null`.
- A live file is signed with your live key; a test file (`"environment": "test"`) with your test key.
- Cover every product you sponsor; the answer lists any you left out (`missing`), and those read as null with a reason.
- `as_of` must be newer than your last file for that environment, not in the future, and at most 36 hours old.
- A file with `"environment": "test"` is for conformance only and never read as live.

Mynt checks the schema, your firm, the signature and the clock when you upload, and stores the file sealed (admins see only its time and how many products it covers). It checks the file again on every read: against your **current** live key, so replacing that key stops an old file counting at once, and its age, so once your latest live file is older than 36 hours, snapshots say `source: unavailable` until the next one arrives.

## (b) The customer's home state

A live money movement needs the customer's home state verified by an identity provider you accept: an identity service your own firm offers, or one you approved for the sponsorship with `approve_identity_provider`. Its output must carry `residential_state` (ISO 3166-2, e.g. `us-ny`) **only** when its check verified the address and passed. Conformance calls each provider you accept in its test environment with the service type's test inputs and passes when at least one answers a passed check with a valid `residential_state`. A ramp adapter's partner record can't be tested this way, and an offering that needs a credential is tested by its vendor's own `run_conformance`.

## (c) Money rails

Propose your rails with `propose_rail`; an admin approves them against your licences. A ramp adapter (or your own offering speaking the wire contract) passes its own `run_conformance`. Conformance here reports each rail you hold, its status and its offering's latest conformance run. It passes when at least one approved rail that carries transfers has passed.

## Conformance: see it pass before you go live

1. Register your key and take the request secret (above).
2. Point your test endpoint at your test books.
3. Run `run_partner_conformance { "source": "http" }` (or `"file"` after uploading a test file).
4. Read the cases. Fix what failed, run again. Every run is kept, with its time, in `get_partner_kit` and in `get_my_entity` (`partner_kit`).

| Case | Passes when |
|---|---|
| `setup` | Your endpoints are confirmed, the secret was issued, your live and test keys are registered, and you sponsor at least one product |
| `answer` | Your test endpoint answered a signed request with `200` and JSON |
| `schema` | The statement matches the schema (integers, nulls with reasons, no extra members) |
| `identity` | Your firm id, the `test` environment, and the echoed `request_id` |
| `signature` | It verifies with your registered test key (not your live key) |
| `clock` | `as_of` isn't in the future (300 s grace) or older than the maximum age |
| `null_handling` | Every null figure has a reason |
| `coverage` | Every product you sponsor is answered |
| `unknown_product_null` | A product id Mynt made up comes back null with a reason, not 0 and not left out |
| `bad_signature_refused` | A request signed with the wrong secret gets `401` and an error body |
| `stale_request_refused` | A correctly signed request from 600 s ago gets `401` and an error body |
| `malformed_request_refused` | A correctly signed request with no `product_ids` gets `400` (or `422`) and an error body |
| `wrong_environment_refused` | A correctly signed request for `"live"`, sent to your test endpoint, gets a `4xx` and an error body |
| `wrong_audience_refused` | A correctly signed request whose `audience` is another URL (your live endpoint's) gets a `4xx` and an error body |
| `live_wrong_audience_refused` | Your **live** endpoint refuses a correctly signed live request whose `audience` is your test endpoint's URL (it names only a product Mynt made up, so no live figure is asked for, and anything that comes back is dropped unread) |

For the file source, the cases are `setup` and the statement checks above, run on your latest upload. The run also reports (b) as `identity` and (c) as `rails`, each with its own `passed`.

**Going live.** When the ledger part passes (`can_go_live: true`), switch with `set_partner_ledger_source { "source": "http" }`. Mynt then reads your live endpoint once and checks the statement, which must be signed with your live key (the figures are discarded); if that passes, your next snapshots read your live books and are marked `source: partner_ledger`. For the file source, upload a live file first, then `set_partner_ledger_source { "source": "file" }`. `set_partner_ledger_source { "source": "sandbox" }` goes back. An admin can also send your firm back to the sandbox, never switch it to live, and you're told with a `partner_ledger.source_changed` event on your webhooks.

**A pass runs out.** Each run has an `expires_at`, 30 days after it ran; you're warned a week before (`partner_ledger.conformance_expiring`) and told when it happens (`partner_ledger.source_changed`). A pass that has run out neither lets you switch nor keeps you live: your snapshots go back to the sandbox until you run conformance again, so run it on a schedule. `get_partner_kit` shows `live_until`.

(b) and (c) don't hold up the ledger switch: they're checked on every money movement already, and conformance shows you where you stand.

**When things change.** An endpoint change takes effect only when you confirm it, and then you're back on the sandbox until you pass conformance again. Rotating the request secret doesn't change your source; update your endpoint as soon as you rotate.

## What Mynt does and doesn't do with your figures

- They go only into the product-health snapshot, encrypted per product, readable by your firm and by the liquidity providers in that product's pools. Admins see status, times and fingerprints, never the numbers.
- They're never logged, and conformance results never contain them.
- A covenant you set on a product can pause it; a pause stops new sign-ups only, and money already moving is left alone.

## Limits

| Setting (on Mynt's server) | Default |
|---|---|
| `PARTNER_LEDGER_MAX_AGE_HOURS`: oldest `as_of` accepted from the feed | 24 |
| `PARTNER_LEDGER_FILE_MAX_AGE_HOURS`: oldest daily file accepted or read | 36 |
| `PARTNER_CONFORMANCE_MAX_AGE_DAYS`: how long a conformance pass counts | 30 |
| `PARTNER_LEDGER_TIMEOUT_MS`: time limit per request (one request per firm per round) | 10000 |
| Clock skew allowed on `as_of` and on Mynt's request timestamp | 300 s |
| Largest answer | 1 MiB |
| Products per statement | 1000 |
