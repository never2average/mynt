# Runtime API

This file covers what a shipped app calls at run time: its keys, the `/v1` routes, hand-offs, webhooks, sandbox mode, releases, client sessions for customers' devices, the generated SDKs, journeys and the customer vault. It is for developers integrating an app with Mynt.

See also: [Apps and builds](apps-and-builds.md), [Products](products.md), [Hosting](apps-and-builds.md#hosting), [Vendors and the marketplace](vendors-and-marketplace.md), [the architecture](../architecture.md).

The Model Context Protocol (MCP) tools are for building. A shipped app talks to Mynt's runtime API under `/v1`, which is separate from `/mcp`: requests authenticate with a per-app key, not a sign-in. Hosting an app is not covered here; see [Hosting](apps-and-builds.md#hosting).

## Keys

`create_api_key(app_id, environment, label, allowed_origins?)` returns a key once. Mynt stores only its SHA-256 hash.

| Key | Works |
| --- | --- |
| `mynt_live_…` | Only once the app is published |
| `mynt_test_…` (sandbox mode) | On drafts too |

Manage keys with `list_api_keys`, `rotate_api_key` (the old secret stops working at once) and `revoke_api_key`. Each of these is audit-logged.

Send the key as `Authorization: Bearer mynt_live_…`.

An app key belongs on the builder's server. A customer's browser or phone gets a client session instead (see [Client sessions](#client-sessions)).

## Calling the API

### Routes for an app key

| Route | Does |
| --- | --- |
| `GET /v1/products` | `{ products: [...] }`: the products this app may show right now (published, and access granted for the app), each with its fields, `version` and `build_terms`. Revoked or suspended products drop out immediately |
| `GET /v1/products/{id}` | One of those, else `404` |
| `GET /v1/products/{id}/contract` | The product's developer contract, for its live version |
| `POST /v1/handoffs` | `{ product_id, action: "deep_link" \| "initiate_onboarding", consumer_ref? }` returns `201 { handoff_id, redirect_url, sandbox }`. Only if the product's build terms permit the action (`403` otherwise) |
| `POST /v1/events` | `{ type: "view" \| "click" \| "handoff_started", product_id, screen? }` returns `202` |
| `POST /v1/client_sessions` | Mints a client session for one customer's device. Server only |
| `POST /v1/sandbox/handoffs/{id}` | Sandbox key only: `{ outcome: "completed" \| "failed" }` resolves a simulated hand-off |

The routes a device calls with a client session are listed under [Client sessions](#client-sessions).

### No customer financial data

The API never takes or returns consumer financial data.

- `consumer_ref` is the app's own opaque id: letters, digits, `_` and `-`, up to 64 characters. Anything that looks like a phone, account or card number is refused.
- Unknown body fields are refused.

### Errors

Errors are JSON `{ error, message }`, with status `400`, `401`, `403`, `404`, `405`, `409`, `413`, `429` or `500`.

### Limits

- Each key gets 60 requests a minute (a token bucket). Past that, the API answers `429` with `Retry-After`.
- Request bodies are limited to 16 KiB.

### CORS

There is no wildcard. A browser may call the API only from the origins listed on the key (`allowed_origins`). A key with no origins is for server-side use only.

## Hand-offs

A hand-off sends the customer from the app to the product's own flow, for onboarding, identity checks and payments.

- The product's builder sets `handoff_url` (https) in the product's build terms with `set_product_access`.
- `POST /v1/handoffs` returns a `redirect_url`. With a live key it is the product's `handoff_url` with `?handoff_id=…&app_id=…`, or `409 handoff_not_configured` if the product has none.
- When the onboarding finishes or is abandoned, the product's builder calls `report_handoff_outcome(handoff_id, outcome)`.

Only the outcome is shared, never customer data.

## Webhooks

Each app can register webhooks to hear about its products and hand-offs.

### Webhook tools

| Tool | Does |
| --- | --- |
| `create_webhook(app_id, url, events[])` | Registers a webhook and returns the signing secret once |
| `list_webhooks` | Lists an app's webhooks |
| `rotate_webhook_secret` | Replaces the signing secret |
| `delete_webhook` | Removes a webhook |
| `list_webhook_deliveries(webhook_id)` | Shows each delivery's status, attempts and last response code |
| `enable_webhook(webhook_id, url)` | Turns a disabled webhook back on |

A webhook stops when the person who made it leaves the workspace, since its address may be theirs. A workspace's owners and admins turn it back on with `enable_webhook`, which takes its URL (the one it has, to confirm it is still the right receiver, or a new one) and gives it a new signing secret, shown once.

### App events

| Event | Sent when |
| --- | --- |
| `product.version_published` | A product the app uses published a new version |
| `product.unpublished` | A product was taken out of the catalogue |
| `product.suspended` | A product's builder used the kill switch (`suspend_product_experiences`) |
| `product.drifted` | A product drifted: something it rests on changed since it was published |
| `product.drift_cleared` | That drift was cleared |
| `access.approved` | The app's access to a product was approved |
| `access.revoked` | The app's access to a product was revoked |
| `request.decided` | A request of the app's builder was decided |
| `handoff.completed` | A hand-off completed |
| `handoff.failed` | A hand-off failed |
| `handoff.reversed` | A completed Mynt Ramp transfer was later sent back by the bank. The event carries no customer data |

Each event goes to every webhook of every app affected.

Firms get a separate set of events at their own webhooks, about what Mynt did for the firm. See [Firm webhooks](vendors-and-marketplace.md#firm-webhooks).

### Webhook addresses

Webhook URLs, apps' and firms', must be https on a public address. That is checked when they are created and again at every delivery:

- the name is resolved;
- it is refused if any address is private, loopback, link-local, carrier-grade NAT or reserved, in any notation;
- Mynt connects to the address it checked, without following redirects.

Plain http to loopback (`http://127.0.0.1`) is allowed outside production, for local testing.

### Delivery

- Each body is `{ id, type, created_at, data }`, where `data` includes the receiving `app_id`.
- A delivery that fails is retried with exponential backoff: 30 seconds, 1 minute, 2 minutes and so on, doubling each time, 8 attempts in all.
- `serve-http` runs the delivery worker.

### Verifying a signature

Verify the `Mynt-Signature: t=<unix>,v1=<hex>` header against the raw body:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyMynt(secret, header, rawBody, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

## Sandbox and releases

### Sandbox mode

Sandbox keys (`mynt_test_…`) see the same product data as live keys. Hand-offs are simulated:

- `redirect_url` points at a Mynt sandbox page.
- Resolve a hand-off with `simulate_handoff(handoff_id, outcome)` or `POST /v1/sandbox/handoffs/{id}`. Either one sends `handoff.completed` or `handoff.failed` to your webhooks.
- `create_test_consumer(app_id, label)` gives you an opaque `consumer_ref` to test with.
- Sandbox events and hand-offs are stored but flagged, and are left out of live analytics.

### Releases

`release_app(app_id, version, changelog)` runs `publish_app`'s checks, publishes the app, and snapshots the whole app definition.

- Versions are semver and must increase.
- `list_app_releases` shows the history.
- `rollback_app(app_id, version)` makes an earlier snapshot current again, if it still passes the products' current terms.
- `publish_app` records a first release (`1.0.0`) if an app has none.

## Client sessions

An app key belongs on the builder's server. A customer's browser or phone gets a client session instead.

### Minting a session

`POST /v1/client_sessions` takes an app key and is server only: it is refused when sent from a browser. It mints a session for one customer, with:

- its products, each of which needs a developer contract;
- its scopes: client actions taken from those contracts;
- a lifetime of at most an hour (`ttl_seconds`, from 60 to 3,600, default 1,800).

It returns a `mcs_…` secret to send to the device.

### Routes for a device

The device calls `/v1/client/*` with that secret, and only from the origins the app's key allows.

| Route | Does |
| --- | --- |
| `GET /v1/client/offers` | Returns the contract's offers, documents, consent purposes and the actions the session may start |
| `POST /v1/client/evidence` | Records that a document was shown (with a hash of the exact text), or that consent was given or withdrawn. It only accepts the contract's own documents and consent purposes |
| `POST /v1/client/actions/{action}` | Starts a provider-hosted flow and returns where to send the customer. It is refused until the action's consent is recorded in that session, and again after the consent is withdrawn |
| `GET /v1/client/journeys/{journey}` | Returns a journey saved to the app (see [Journeys](#journeys)) |
| `GET /v1/client/fields`, `POST /v1/client/fields`, `DELETE /v1/client/fields` | Read, store and erase customer data (see [The customer vault](#the-customer-vault)) |
| `POST /v1/client/prefill` | Fetches fields from an outside source, with consent (see [The customer vault](#the-customer-vault)) |
| `POST /v1/client/ramp_links` | Asks to link the customer to the Mynt Ramp's partner, after the ramp's consent (see [The Mynt Ramp](vendors-and-marketplace.md#the-mynt-ramp)) |

Evidence is stored against the contract version, ready for the builder's governance, risk and compliance (GRC) folder.

Servers read a contract with `GET /v1/products/{id}/contract`.

## SDKs and experiences

### Defining and releasing an SDK

`create_sdk(name, languages, product_ids)` defines an SDK over products you can build on: open or approval products, or private ones you were invited to.

`generate_sdk_release(sdk_id, version, changelog)` then writes an immutable, semver-versioned bundle.

| In the bundle | Contents |
| --- | --- |
| `openapi.json` | An OpenAPI 3.1 document for the app API (`GET /v1/products`, `GET /v1/products/{id}`, `POST /v1/handoffs`, `POST /v1/events`, signed webhooks), with a schema per product built from its fields |
| `typescript/src/schema.d.ts` | Types generated from the document by [openapi-typescript](https://openapi-ts.dev), used by an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client for every operation |
| `typescript/src/index.ts` | Mynt's helpers for servers: `createMyntClient`, `startHandoff` (typed to each product's permitted hand-offs), `trackEvent`, `verifyWebhook`, and constants for every product's required disclosures, branding and banned phrases (`disclosuresFor(id)`) |
| `typescript/src/browser.ts` | The device entry point, `./browser` |
| `python/` | `generate.sh` runs [openapi-python-client](https://github.com/openapi-generators/openapi-python-client) on the document to produce the client, plus a standard-library `mynt_helpers.py` (`verify_webhook`, `disclosures_for`, `check_handoff`, the same constants) |

openapi-python-client is not a Mynt dependency. Tests use it only when installed; set `OPENAPI_PYTHON_CLIENT` to its path to point at a virtualenv.

### Stale releases

`list_sdks`, `list_sdk_releases` and `get_sdk_release` (files as `{path, content}`) flag a release stale, with reasons, when:

- a product has published a newer version;
- a product changed its build terms;
- a product was unpublished;
- your access was revoked.

Generate a new release to pick the changes up. `get_product_sdk` still describes a single product.

### The two TypeScript entry points

- **The default (server) entry** adds `createClientSession` and `getContract`. A session's scopes are typed to the client actions of its products.
- **`./browser`** is `createMyntBrowserClient({ clientSecret })`, with `offers`, `documentShown`, `giveConsent`, `withdrawConsent` and `startAction`. It uses only web APIs (fetch and WebCrypto) and refuses an app key. Its typing won't let a device start a server-only action.

### SDK languages

`create_sdk` languages:

| Language | For |
| --- | --- |
| `typescript` | Servers, plus `./browser` |
| `python` | Servers |
| `react_native` | Devices |
| `kotlin` | Android |
| `swift` | iOS and macOS |
| `flutter` | Dart |

Every device SDK has the same client and journey runner as `./browser`, and each:

- runs on a client session, never an app key;
- carries the app's contract constants (client actions, consent purposes, documents), so misuse fails before any request is sent;
- hashes evidence with the platform's SHA-256: WebCrypto, `MessageDigest`, CryptoKit or swift-crypto, Dart's `crypto`, or plain TypeScript on React Native.

The device SDKs are generated from source templates in [`core/sdk-templates/`](../../core/sdk-templates). Continuous integration compiles a generated set on every change: Kotlin with `kotlinc`, Dart with `dart analyze`, Swift with `swift build`.

### Experiences

`set_experience(app_id, experience)` gives an app a structured definition: screens of `product_card`, `comparison_table`, `calculator` (maturity, emi, sip), `disclosure_block`, `handoff_cta` and `text` components.

On top of the terms lint, `check_experience` and `publish_app` then require that:

- every screen showing a product also carries that product's `disclosure_block`, which renders its required disclosures verbatim;
- calls to action use only hand-offs the product permits, and comparisons only products that permit `compare`;
- components reference only the app's products;
- no banned phrase appears in any title, text or label.

`render_experience_preview(app_id)` returns a self-contained HTML page for review, with product data, disclosures and branding. It has no scripts or external assets, and everything is escaped.

## Journeys

A journey is how an app walks a customer through a product, written as a declarative spec, not code. It is a graph of steps, and each step does one thing:

- a screen of elements: offer cards, documents, data fields, text or an outcome;
- a consent capture;
- one of the provider's hosted actions;
- a wait for a lifecycle event.

Branches use `on: { outcome: step }`.

### Data fields

Data fields come from Mynt's data dictionary (`get_data_dictionary`). Each field has a type and validation, a sensitivity level, and the ways it may be captured: typed, a secure field, a document upload, Account Aggregator, DigiLocker or CKYC.

Each contract action lists the dictionary fields it needs: its `data_requirements`, taken from its handoff's input schema.

### What the journey check enforces

`check_journey` checks every path through the journey:

- consent is captured before any personal data;
- every document the product requires is shown before any hosted action;
- every field an action needs is collected before it;
- no field is collected that no action needs;
- sensitive fields go only in secure inputs;
- every step is reachable, and every path ends.

Each error names the step and the fix. The check also lists every path through the journey, for simulation.

### Journey tools

| Tool | Does |
| --- | --- |
| `get_default_journey` | Builds the minimum compliant journey from the product's contract, so builders start from something that already works |
| `check_journey` | Checks a journey, as above |
| `preview_journey` | Renders an HTML outline |
| `save_journey` | Stores a journey on an app |
| `list_journeys` | Shows whether each saved journey is still current |

### Serving a journey to devices

Devices fetch a saved journey with `GET /v1/client/journeys/{journey}`. It is served only while it was checked against the product's live contract. Once a new contract is published, the route returns `journey_outdated` until the builder checks and saves the journey again.

### The journey runner

The browser SDK has methods for the vault and journeys: `saveFields`, `knownFields`, `prefill`, `forgetMe` and `journey`.

It also has `createJourneyRunner(client, journeyId)`, a headless runner. The app renders the current step however it likes, then calls `complete()` with what the customer did. The runner then:

- records document and consent evidence;
- stores fields, with secure ones sent as secure;
- triggers prefill;
- starts hosted actions and returns where to send the customer;
- follows the journey's branches.

## The customer vault

Data a customer gives once is kept per app and per customer reference, so the next journey can skip asking for it.

- It is encrypted at rest with AES-256-GCM, using `MYNT_VAULT_KEY`. The host installer generates that key once and keeps it across runs. A server that runs a confidential host can move the key into it; see [Confidential computing](confidential-computing.md).
- Sandbox sessions use a key that exists only in that process.
- Values are never returned to devices: only which fields are held, masked.

### Vault routes

The device routes need a client session that has a `customer_ref`.

`POST /v1/client/fields` stores values. The server enforces the rules:

- only fields one of the product's client actions needs;
- only after an active consent;
- sensitive fields only from a secure field;
- every value validated against the data dictionary.

`GET /v1/client/fields` shows what is held, masked.

`DELETE /v1/client/fields` erases everything held for the customer.

### Prefill

`POST /v1/client/prefill` fetches fields from Account Aggregator, DigiLocker or CKYC, with consent. The app sends the same request whether or not a vendor serves it.

When the product hands off to a vendor's standard service for that source (see [Vendors and the marketplace](vendors-and-marketplace.md)), Mynt calls the vendor: its test endpoint for sandbox sessions, and its live one once the product's builder turned the subscription live.

| Answer | Means |
| --- | --- |
| `409 consent_required` | The service's own consent purpose must be recorded first |
| `409 data_required` | The service's inputs must be in the customer's vault |
| `502 vendor_error` | The vendor's answer didn't match the service's output schema. No field is saved before that check passes |
| `503 vendor_unavailable` | The offering is suspended |

Without a vendor, sandbox sessions get realistic fixture values, and live connectors return `501` until they are configured.

### Hosted actions and the vault

A hosted action refuses to start (`data_required`) until the personal data it sends is held for the customer.

An action served by a vendor's standard service (`served_by` in the contract) answers with `{ reference, action, status, sandbox }` and only what the service type allows, such as a `redirect_url` to the provider's page for e-sign and e-mandate. It never returns the vendor's result: that goes to the product's builder. See [Calling a vendor's service](vendors-and-marketplace.md#calling-a-vendors-service).

## Developer modules

Builders publish reusable modules under their own namespace: `check_module`, `publish_module`, `list_modules`. A module is something like an EMI planner component, a journey step or a webhook handler, built on products' developer contracts.

Mynt checks each manifest against the live contracts:

- the actions exist, and may run where the module runs: client modules only client actions, isomorphic ones only actions that run on either side;
- every consent those actions need is declared;
- a client component renders every document its products require.

Beyond the checks:

- **Namespaces** are first come, first served.
- **Versions** are immutable.
- **Verified:** a module is marked verified when its code comes from a build Mynt verified.
- **Outdated:** once a product publishes a new contract, modules built on the old one show as not current.

## Analytics

- For an app: `get_app_metrics(app_id, from?, to?, include_sandbox?)` gives views, clicks and hand-offs (started, completed, failed) per product and per day. It also gives conversion (completed hand-offs per view) and the hand-off completion rate. Only live traffic counts unless you set `include_sandbox`.
- For a product: `get_product_distribution_metrics(product_id)` shows how one of a builder's products performs across every app that shows it.
