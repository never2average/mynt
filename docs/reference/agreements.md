# Agreements

This file covers the business agreements between an app and the firms behind its products: their kinds and scopes, the program agreements an app needs before production, e-signature, the oversight audits a licence provider runs under an agreement, and service levels. It is for builders, licence providers and vendors.

See also: [Firms, licences and licence providers](licence-providers.md), [Vendors and the marketplace](vendors-and-marketplace.md), [Workspaces and sign-in](workspaces-and-sign-in.md), [Risk](risk.md), [Mynt Studio](studio.md).

## App agreements

An app is the distribution layer and **holds no licences of its own**. The financial products it uses are the regulated things, each covered by its own firm's licences or a licence provider's sponsorship. An app's licence coverage is its products'.

What the app's workspace does hold is business agreements with the firms behind those products. Every agreement is for **one app**, whatever its kind, and needs a yes from both sides, like the connector's introductions.

Builders, licence providers and vendors all hold agreement tools. The app's side is the workspace's owners and admins. The other side, the counterparty, is a member of the other firm acting as its licence provider (with standing) or vendor.

### Kinds

| Kind | With | Mynt checks |
| --- | --- | --- |
| `program` | A licence provider sponsoring products the app uses | The firm sponsors (an approved sponsorship) every product the agreement names, and the agreement names at least one |
| `vendor` | A vendor firm whose services the app relies on | The firm lists vendor offerings on Mynt. Usually made by accepting the vendor's standard terms when subscribing, already signed by both (see [The marketplace and standard terms](vendors-and-marketplace.md#the-marketplace-and-standard-terms)) |
| `data_sharing` | Either of those | The firm sponsors one of the app's products or lists vendor offerings |
| `msa` | Either of those: a master services agreement (MSA) | As for `data_sharing` |
| `sla` | Either of those: a service-level agreement (SLA) | As for `msa`. Its commitments are set with `add_agreement_sla` (see [Service levels](#service-levels)) |

### Statuses

An agreement is `proposed`, `accepted`, `signed`, `declined` or `terminated`.

An open agreement is one that is `proposed`, `accepted` or `signed`. There is one open negotiated agreement of a kind per app and counterparty. Click-through vendor agreements are one per app and subscription.

### Two sides

Agreements are two-sided: either side proposes, and the side that didn't propose answers. `proposed_by_side` (`app` or `counterparty`) says which proposed.

| Step | Tool | Who |
| --- | --- | --- |
| Propose, from the app's side | `propose_app_agreement` | The app's workspace owners and admins |
| Propose, from a firm | `propose_workspace_agreement` | A licence provider |
| Change the scopes of a proposal | `update_agreement_scopes` | The side that proposed it |
| Respond | `respond_to_app_agreement` | The side that didn't propose it |
| Sign | `sign_app_agreement`, or e-signature for program agreements | Both sides |
| End | `terminate_app_agreement` | Either side |
| Read | `list_app_agreements` | Both sides |

### Proposing from the app

`propose_app_agreement({ app_id, counterparty_entity_id, kind, scopes, products?, terms_summary, document_url?, document_sha256?, effective_from?, effective_to? })`

- `products` are ids of the app's own products.
- The document link must be https. Its SHA-256 (64 lowercase hex) is kept with it.
- The other firm is told: an `app_agreement.proposed` event on its webhooks and a notice to each member (`list_firm_notices`).

### Proposing from a licence provider

`propose_workspace_agreement({ workspace_id, app_id, kind, scopes, products?, terms_summary, document_url?, document_sha256?, template_id?, effective_from?, effective_to? })`

- `workspace_id` is the app's workspace.
- `kind` is `program`, `data_sharing`, `msa` or `sla`.
- A program agreement names the products the licence provider's firm sponsors for the app.
- `template_id` is one of its firm's agreement templates in use. A program agreement's e-signature document is then made from it, in place of the firm's most specific one.
- The app must use products the firm sponsors, or have an agreement with it already.
- The workspace's members' firms are told (`app_agreement.proposed`), and the workspace's attention list has an `app_agreement_proposed` item until the proposal is answered.

### Responding

`respond_to_app_agreement({ agreement_id, decision: "accept" | "decline", note? })` is called by the side that didn't propose:

- a member of the counterparty firm acting as its licence provider (with standing) or vendor; or
- the workspace's owners and admins.

The proposer can't answer its own proposal. It may withdraw it. Declining ends the agreement. When the app's side answers, the firm is told (`app_agreement.answered`).

### Signing

- Where e-signature is configured, program agreements are signed on the licence provider's own agreement (see [E-signature](#e-signature)).
- Otherwise `sign_app_agreement({ agreement_id })` records one side's signature on an accepted agreement: the app's owners or admins for the app, a member of the other firm for the firm.

An agreement becomes `signed` only once both sides have signed. The other firm is then told (`app_agreement.signed`).

### Ending

`terminate_app_agreement({ agreement_id, reason })` is called by either side, on a proposed agreement (a withdrawal), an accepted one or a signed one. The other firm is told when the app's side ends it (`app_agreement.terminated`).

### Reading agreements

Every agreement in a reply names:

- its `scopes` (keys) and `scope_labels` (in words);
- `proposed_by_side`;
- the `template` it was made on: `{ id, name, version }` or `null`;
- `your_side`: `app`, `counterparty` or `both`;
- `actions`, what the caller may do now: `accept`, `decline`, `sign`, `withdraw`, `end`.

`list_app_agreements` has three forms. `status` and `scope` (one of the scope keys: only agreements covering it) filter any of them.

**`list_app_agreements({ app_id })`**, for any member of the app's workspace, returns:

- the app's agreements, each with both parties named, the products it covers, its status, signatures and effective dates;
- the products the app uses, each with its stage, the licence providers sponsoring it and the states they sponsor it in;
- the vendor services its workspace relies on: active subscriptions of its members' firms, each with the version of the vendor's standard terms accepted for this app and its `scopes` and `scope_labels` (`null` with no agreement for this app), or `no_standard_terms`;
- the introductions the connector has in progress for its members. The other side is named only once both have said yes. This is `null` when the connector doesn't run on this server.

**`list_app_agreements({ workspace_id })`**, for any member, returns every agreement of the workspace's apps (all kinds), `can_manage`, its apps, and `proposable_counterparties: [{ entity_id, name, product_ids, app_ids }]`: the licence providers sponsoring its apps' products.

**`list_app_agreements()`** with neither, for a licence provider or vendor, lists the agreements naming its firm, whichever side proposed them. A licence provider also gets `proposable_workspaces: [{ workspace: { id, name }, apps: [{ id, name, product_ids, sponsored_product_ids }] }]`.

### Audit and attention

Every change is audited with the app's id (and the workspace's) and the `side` that made it, in the obligations class: `propose_app_agreement`, `update_agreement_scopes`, `accept_app_agreement`, `decline_app_agreement`, `sign_app_agreement`, `terminate_app_agreement`, `accept_vendor_terms`.

The app's side hears of the other firm's answers, signatures and terminations in its workspace's attention list (`app_agreement_update`; see [The other firm's side in the attention list](#the-other-firms-side-in-the-attention-list)).

`remove_app` refuses an app with agreements, which are the other firm's record too.

## Scopes

Every agreement records **one or more scopes**: what it covers, from a fixed list (`AGREEMENT_SCOPES` in `core/src/app-agreements-schema.ts`, which Mynt Studio shows by the same labels).

| Scope | Label | Covers |
| --- | --- | --- |
| `technology` | Technology | A platform or software licence |
| `manpower` | Manpower | People and staffing |
| `financial_regulatory_operations` | Financial regulatory operations | Compliance and regulatory operations |

Rules:

- Both propose tools require `scopes`: at least one, each once, only from the list. Anything else is refused.
- The scopes are part of what the other side accepts and what is signed. An e-signature program schedule states them ("Scope of the agreement").
- Agreements made before scopes were recorded keep an empty list, which Studio shows as "Not set". Mynt never fills one in.
- `scope` filters find agreements by scope.

### Changing scopes

While an agreement is still `proposed`, the side that proposed it may change its scopes with `update_agreement_scopes({ agreement_id, scopes })`: the workspace's owners and admins for one their side proposed, a licence provider for one its firm proposed.

- Nothing else about the agreement changes.
- The change is audited (`update_agreement_scopes`, with `from_scopes` and `scopes`).
- The other side is told (`app_agreement.proposed` with `updated: "scopes"`).
- Once the proposal is answered, the scopes are fixed.

### Scopes on a vendor's standard terms

A vendor's standard terms carry scopes. A click-through agreement (`subscribe_vendor_service`) copies the scopes of the standard terms version accepted. Only one accepted on a terms version from before scopes were recorded has none ("Not set"). See [The marketplace and standard terms](vendors-and-marketplace.md#the-marketplace-and-standard-terms).

## Production needs program agreements

An app moves to `production` only with a **signed program agreement** with every licence provider sponsoring **each product it uses**, covering that product. This is the `program_agreements` promotion check. See [Stages and promotion](workspaces-and-sign-in.md#stages-and-promotion).

### Which licence providers

- Every licence provider with an approved sponsorship of the product counts, wherever it sponsors the product and whichever states the app serves.
- A product no licence provider sponsors is covered by its own firm's licences and needs no agreement.
- One agreement may cover several of the app's products from the same licence provider.
- A product with two sponsoring licence providers needs an agreement with each.

### In force

An agreement counts when:

- its `status` is `signed` (both sides signed);
- `effective_from` is unset, or on or before today;
- `effective_to` is unset, or today or later (the last day it runs).

A `vendor` or `data_sharing` agreement doesn't count.

### The check

`get_promotion_checks` gives it as `{ id: "program_agreements", label: "Signed program agreement with each product's sponsor", status, detail, fix?, coverage }`.

- Each missing pair fails the check in plain words: `No signed program agreement with <sponsor> for <product>`.
- Why the nearest agreement doesn't count follows in brackets. The reasons are:
  - `proposed, waiting for <sponsor> to accept`
  - `<sponsor> accepted it; waiting for your signature`
  - `its signed agreement takes effect on <date>`
  - `its signed agreement ended on <date>`
  - `it was ended on <date>: <reason>`
  - `<sponsor> declined it`
- `fix` is optional. It is `Propose agreement` (`propose_app_agreement`, the app's Agreements tab).
- `coverage` lists each pair: `{ product_id, product_name, sponsor_entity_id, sponsor_name, covered, agreement_id, agreement_status, note }`.
- With nothing to agree, the check passes as "Not applicable".

### The app's view

`list_app_agreements({ app_id })` also returns `program_coverage` (the same pairs) and `production_gate: { met, missing, flagged }`, with the app's `stage`.

### Ending after go-live

An agreement that is terminated or expires after the app reached production doesn't move the app back. The app keeps running, and:

- `production_gate.flagged` is true;
- its production checks fail, so the workspace's attention list has a `promotion_checks_failing` item naming the missing agreement;
- `ops_status` lists it under `apps.production_without_program_agreements` with an attention line.

There is no event channel to an app's workspace. App webhooks carry runtime events, whose list the generated SDKs pin. So the attention list is how the workspace hears of it.

### The other firm's side in the attention list

Each acceptance, decline, signature and termination by the other firm in the last 14 days is an `app_agreement_update` item in the workspace's attention list, linking to the app's Agreements tab.

| Priority | When |
| --- | --- |
| High | It ended a program agreement |
| Medium | Another agreement ended or was declined, or an agreement waits for an owner's or admin's signature |
| Low | Otherwise |

Where the agreement is signed by e-signature, the same list has:

- the other firm's signature on the document;
- the document completed, signed by both sides (low);
- the document declined at signing (medium);
- the document expired or cancelled at the service (high for a program agreement).

The `program_agreements` check's "waiting for your signature" or "waiting for <sponsor>'s signature" reads the document's signatures.

## Target customers

`get_app_customers({ app_id })`, for any member, lists:

- the customer segments (personas) each of the app's products declares (`customer_segments` in its definition);
- which ones the app targets;
- the app's customers where Mynt measures them: distinct customers with client sessions and with records in the customer vault, live and sandbox apart.

Without client sessions in an environment, its counts are `null` with the reason, never 0.

`set_app_target_segments({ app_id, segments: [{ product_id, segment_id }] })`, for owners and admins, replaces the app's choice. Each entry is a segment its product declares. It is audited as `set_app_target_segments`.

## E-signature

Where e-signature is configured, a program agreement is signed on the licence provider's own agreement, by both parties, through an e-signature service, and Mynt keeps the signed copy.

- The core is brand-neutral (`core/src/esign/provider.ts`).
- Each service is an adapter (`core/src/esign/signwell.ts`) chosen by a setting.
- The flow is in `core/src/agreement-esign.ts`.

Every kind except `program` (`vendor`, `data_sharing`, `msa` and `sla`) keeps the manual `sign_app_agreement` flow, whether or not e-signature is configured.

### Agreement templates

A licence provider's members upload their firm's program agreement once, and Mynt uses it for every app that signs with them. Only the firm's own licence providers (with standing) manage its templates. A Mynt admin can't act for them.

| Tool | What it does |
| --- | --- |
| `upload_agreement_template` | Adds a template or the next version of one |
| `list_agreement_templates` | The firm's templates (`include_retired` for older versions), never the file |
| `retire_agreement_template` | Stops using a version for new agreements. Documents made from it are unaffected |

`upload_agreement_template` takes `{ name, source?: "upload" | "provider_template", licence_id? | sponsorship_id?, file_name?, file_base64?, provider_template_id?, placeholders?, field_map?, signature_placement?, notes? }`.

- **An upload** is a PDF or DOCX, checked by its bytes, at most 5 MB. It is sealed with `MYNT_VAULT_KEY` and kept with its SHA-256.
- **A provider template** is the id of a template the firm keeps at the e-signature service, with the names of its two signer placeholders (`counterparty`, `app`) and a `field_map` from Mynt's variables to the template's field ids.
- Mynt's variables are `licence_provider`, `developer_firm`, `app`, `products`, `states`, `effective_from`, `effective_to`, `agreement_id`, `terms_summary` and `scope`.
- Attach the template to one of the firm's licences or sponsorships, or to neither for the firm's default.
- `signature_placement` is `signature_page` (a signature page added at the end, the default) or `text_tags` (the file carries the service's text tags).
- Versions never change. The same name again is the next version, and the active one.

### The signing flow

1. **Propose and accept.** Either side proposes the program agreement and the other accepts it, as in [App agreements](#app-agreements).
2. **Mynt makes the document.** On acceptance, Mynt picks the template: the one the licence provider proposed the agreement on (`template_id`) while it is still in use, else the firm's most specific active template. Most specific means one attached to an approved sponsorship of the agreement's products, else to a licence those sponsorships are approved under, else the firm's default.
3. **Mynt appends its program schedule**, a PDF stating what Mynt fills in: both parties, the builder's firm, the app, the products, the scope (its scopes in words, or "Not set"), the states the sponsorship covers, the dates, the agreement's id, and the template's version and SHA-256.
4. **Two signers.** Mynt creates the e-signature document with two signers: whoever acted for the licence provider (accepted the agreement, or proposed it) and whoever acted for the app. They sign in either order.
5. **Each signer opens a signing page.** `get_agreement_signing_link({ agreement_id })` gives the signer on the caller's side an embedded signing page, which Studio opens in a sheet. Only that signer gets it, and it is asked for afresh each time. Mynt never stores it.
6. **The service reports back.** See [The e-signature webhook](#the-e-signature-webhook).
7. **Both sides download.** `download_agreement_document({ agreement_id, part?: "signed" | "certificate" })` returns the file as base64 with its SHA-256, checked against the recorded hash. Only members of either party can read it: the app's workspace, or the other firm.

If the firm has no template yet, or the service can't be reached, the agreement stays `accepted`. The document is made the first time a signer asks to sign.

### The e-signature webhook

The service's webhook (`POST <PUBLIC_URL>/esign/webhook`) is checked against the service's own scheme with the raw body and a constant-time compare.

- Events older than three days are refused.
- Each event is handled once.
- An event only prompts Mynt to read the document's state back from the service, because the service's signature doesn't cover the document an event names.
- Opening a signing link or a signed copy reads the state too.

### What signed means

Only a document the service reports completed, with both signers signed, signs the agreement. Mynt then:

1. downloads the signed copy, and the same with the service's audit certificate (who signed, when and from where);
2. seals both with `MYNT_VAULT_KEY`;
3. records each SHA-256 (the signed copy's becomes the agreement's `document_sha256`);
4. sets the agreement `signed` with `signed_at`.

Other outcomes:

- A signer declining makes the agreement `declined`.
- The document cancelled or expired ends it (`terminated`).
- Ending an agreement whose document is still out cancels the document at the service.

With e-signature configured, `sign_app_agreement` refuses program agreements. Without it, the manual flow is how both sides record their signatures.

### What the tools and the audit trail show

`list_app_agreements` shows each program agreement's `signed_by_esignature` and `signature_document`: its status, test mode, template, whether each side has signed, and the signed copy's hashes.

Every step is audited, in the obligations class: `upload_agreement_template`, `retire_agreement_template`, `esign_document_created`, `esign_document_failed`, `open_agreement_signing`, `esign_signer_signed`, `esign_completed`, `esign_declined`, `esign_canceled`, `esign_expired`, `download_agreement_document`.

### Setting it up in Mynt Studio

Nobody edits the server's environment. A Mynt admin opens **Platform admin → Platform settings** (`/platform/settings`; see [Platform settings](platform-admin.md#platform-settings)) and does the rest in its E-signature section. The old workspace **Settings → E-signature** address goes there.

1. **Save the key.** Pick the service (`signwell`), paste its API key into the password field and press **Check and save key**. Mynt checks the key with a cheap authenticated read of the key's own account. A key the service refuses isn't kept. An accepted key is sealed under `MYNT_VAULT_KEY` in Mynt's database (`platform_secrets`, one row per key). It is never returned, shown or logged: the section shows only "Key set on <date> by <admin>".
2. **Mynt registers the webhook.** It registers the service's webhook to `<PUBLIC_URL>/esign/webhook`, reusing one already pointing there, and seals the webhook's id the same way. The service signs its events with that id (HMAC-SHA256 of the event's `type@time`). **Re-register webhook** does this again. Without an https `PUBLIC_URL` the key is kept, and the section says the webhook waits for one.
3. **Choose the mode.** **Test mode** is a switch, on by default. On: documents are free and not legally binding, for trying the whole flow. Off: documents are legally binding and count towards the service's billing. Documents already made keep the mode they were made in.
4. **Remove the key, when needed.** **Remove key** deletes the webhook at the service, then the stored key and webhook id. Program agreements are then signed by hand.

The section shows whether e-signature is on, the key's line, the mode, whether the webhook is registered, and when Mynt last received an event.

### E-signature admin tools

The tools behind the section are `get_esign_settings`, `set_esign_api_key`, `register_esign_webhook`, `remove_esign_api_key` and `set_esign_test_mode`. They are for Mynt admins only and never return a secret.

They are audited in the security class without any value: `set_esign_api_key`, `set_esign_api_key_refused`, `register_esign_webhook`, `register_esign_webhook_refused`, `remove_esign_api_key` and `set_esign_test_mode`.

### Environment overrides

Where set, these settings win over what is stored, so a deployment that set them keeps working. Names only:

| Setting | What it is |
| --- | --- |
| `ESIGN_PROVIDER` | The adapter (`signwell`), over the stored choice |
| `SIGNWELL_API_KEY` | Secret. Over the stored key |
| `SIGNWELL_WEBHOOK_ID` | Secret. Over the stored webhook id |
| `ESIGN_TEST_MODE` | `off` for live documents, over the switch |
| `MYNT_VAULT_KEY` | Required to keep the key, the webhook id, templates and signed copies |

Without a key anywhere, e-signature is off. The tools then say "E-signature isn't configured on this deployment yet" and the manual flow stays.

### The signing frame

- The adapter lists the origins the service's signing pages come from.
- `get_agreement_signing_link` says whether the link's origin is one of them (`signing_origin_allowed`).
- Mynt publishes the list at `GET /esign/frame-origins`, which is public, names no secret, and is empty while e-signature is off.
- Studio reads it every few minutes and allows exactly those origins in its Content-Security-Policy `frame-src`, so the Sign sheet frames the signing page.
- `ESIGN_FRAME_SRC` (Studio's setting) can add origins.
- A link from anywhere else is offered in a new tab instead.

## Oversight audits

A program agreement also says which **oversight audits** its licence provider runs on the app: an annual compliance review, a quarterly complaints review, a review of the marketing material on each change.

An agreement has many audit requirements. Each requirement has many audits over time, one open at a time.

The tools are in `core/src/agreement-audits.ts`. The tables (`agreement_audit_requirements`, `agreement_audits`) are in `core/src/agreement-audits-schema.ts`.

These audits are the agreement's own, not the regulator's. The regulatory obligations under `get_workspace_obligations` keep their register's schema and aren't changed by them.

### Audit requirements

A requirement is managed by a licence provider: a member of the agreement's counterparty firm with licence-provider standing.

`add_agreement_audit_requirement({ agreement_id, name, kind, cadence, first_due?, description?, evidence_required? })` adds one to a `program` agreement that is proposed, accepted or signed. So requirements can come with the licence provider's terms before it signs.

| Field | Values |
| --- | --- |
| `kind` | `compliance_review`, `complaints_review`, `marketing_review`, `security_review`, `financial_review`, `other` |
| `cadence` | `once`, `monthly`, `quarterly`, `annual`, `on_change` |
| `first_due` | YYYY-MM-DD. Required except for `on_change`, which has none |

At most 50 live requirements per agreement.

`retire_agreement_audit_requirement({ requirement_id, reason })` stops one. Its open audit is waived with that reason, and closed ones stay.

### Scheduling

Audits run only under a signed agreement. A timer (every minute, `sweepAgreementAudits`), and each add and close, opens a requirement's next audit (`scheduled`) when it has none open.

| Cadence | Next audit |
| --- | --- |
| `once` | One audit, due on `first_due` |
| `monthly`, `quarterly`, `annual` | Due on `first_due`, then a month, three months or a year after the previous one's due date (the day clamped to the month's end). It opens 14, 30 or 60 days before it is due |
| `on_change` | Opens when the app's builds give it new verified source: a succeeded build whose source SHA-256 differs from the one the last audit was opened for. Due 30 days later. The licence provider can also open one by hand |

Mynt can't tell which files customers see, so every new verified source counts as a change.

A due date runs to the end of its day, UTC.

### An audit's life

An audit is `scheduled`, `in_progress`, `submitted`, then `passed`, `failed` or `waived`.

| Tool | Who | What it does |
| --- | --- | --- |
| `open_agreement_audit({ audit_id })` | Licence provider | Opens a scheduled audit. It is in progress and the caller is its reviewer |
| `open_agreement_audit({ requirement_id, due? })` | Licence provider | Opens one by hand, due on `due` or 30 days from now. Refused while that requirement has one open |
| `submit_agreement_audit_evidence({ audit_id, evidence: [{ name, url, sha256 }], note? })` | The app's workspace owners and admins | Adds evidence. The audit becomes `submitted` |
| `record_agreement_audit_finding({ audit_id, severity, title, detail? })` | Licence provider | Adds an open finding and sends a scheduled or submitted audit back to `in_progress`. `severity` is `low`, `medium`, `high` or `critical` |
| `respond_to_agreement_audit_finding({ audit_id, finding_id, response })` | Owners and admins | Answers a finding |
| `resolve_agreement_audit_finding({ audit_id, finding_id, note? })` | Licence provider | Resolves a finding |
| `close_agreement_audit({ audit_id, outcome, note? })` | Licence provider | Closes the audit |

Evidence is https links with their SHA-256. Mynt keeps links and hashes, not files. At most 20 at a time and 50 per audit.

Closing: `passed` only once the audit is `submitted` and every finding is resolved; `failed` or `waived` at any point, with a note saying why. The requirement's next audit then opens when its time comes.

### Reading audits

Only the agreement's two parties read its audits: any member of the app's workspace, and the counterparty firm's licence providers.

`list_agreement_audits({ workspace_id?, app_id?, agreement_id?, status?, overdue?, side? })` returns `{ requirements, audits, counts: { audits, open, overdue } }`:

- each requirement with its counterparty, how many audits it has had, its next due date and whether it is overdue;
- each audit with its requirement, agreement, app and counterparty, `overdue`, `findings_open`, `your_side` and `actions`.

`actions` is what the caller may do next: `open`, `record_finding`, `resolve_finding`, `pass`, `fail`, `waive`, `submit_evidence`, `respond_to_finding`.

`get_agreement_audit({ audit_id })` adds the people named and its `history`: every audit-log entry for it, who made it and when. The schedule's own entries have no actor.

### Overdue audits

Overdue means past its due date and not closed. A submitted audit waiting for review still counts.

An overdue audit flags the app:

- `get_workspace_attention` lists it as `agreement_audit_overdue`;
- `ops_status` counts overdue audits and the apps they are on (`agreement_audits`);
- the lists mark it.

### Audit trail and events for oversight audits

Every change is audited with the app's id, in the obligations class: `add_agreement_audit_requirement`, `retire_agreement_audit_requirement`, `agreement_audit_scheduled`, `open_agreement_audit`, `submit_agreement_audit_evidence`, `record_agreement_audit_finding`, `respond_to_agreement_audit_finding`, `resolve_agreement_audit_finding`, `pass_agreement_audit`, `fail_agreement_audit`, `waive_agreement_audit`.

Both parties' firms are told on their webhooks and notices:

| Event | When |
| --- | --- |
| `agreement_audit.opened` | Opened by the schedule or the licence provider |
| `agreement_audit.submitted` | Evidence or an answer from the app's side |
| `agreement_audit.closed` | Closed, with its outcome |

## Service levels

A service-level agreement (an app agreement of kind `sla`) carries **commitments**: API uptime of 99.9% a month, complaints answered within two business days.

One SLA agreement has many commitments. Each commitment has **breaches** over time: a period in which the measured value missed the target.

The tables are `agreement_slas` and `agreement_sla_breaches` (`core/src/agreement-slas-schema.ts`). The tools are in `core/src/agreement-slas.ts`.

Either party may act: the counterparty firm's licence providers, or the workspace's owners and admins. Plain members read only.

### Service-level tools

**`add_agreement_sla({ agreement_id, metric, target, unit?, measurement_window, measurement_source, remedy? })`** adds a commitment to an `sla` agreement while it is `proposed` or `accepted`. Returns `{ sla }`.

- `target` is a number or words. A numeric one is also kept as `target_value`.
- `measurement_window` is `daily`, `weekly`, `monthly` or `quarterly`.
- `measurement_source` says where the measured value comes from.
- `remedy` says what happens when the target is missed.
- At most 50 active commitments per agreement.
- There is no separate acceptance of each commitment. They are the agreement's terms, in force once it is signed.

**`retire_agreement_sla({ sla_id, reason })`** stops a commitment while the agreement is open. Its breaches stay, and open ones can still be resolved. Returns `{ sla }`.

**`record_sla_breach({ sla_id, period_start, period_end, measured_value, note? })`** records a missed period on an active commitment of a signed agreement. Returns `{ breach, sla }`. The breach says which side recorded it (`recorded_side`).

**`resolve_sla_breach({ breach_id, note? })`** closes an open breach. Returns `{ breach }`.

**`list_agreement_slas({ workspace_id?, app_id?, agreement_id?, side?, include_retired? })`** is for both parties, scoped as `list_agreement_audits` is, over `sla` agreements only. It returns `{ agreements, slas, counts: { slas, active, open_breaches } }`:

- each agreement with its app, workspace, counterparty, `your_side` and `can_add_slas`;
- each commitment with its app, counterparty, `open_breaches`, its `breaches` and its `actions` (`record_breach`, `retire`);
- each breach is `open` or resolved, with who recorded it and its own `actions` (`resolve`).

### Open breaches

An open breach flags the app:

- `get_workspace_attention` lists it as `agreement_sla_breach`;
- `ops_status` counts open breaches and the agreements they are on (`sla_breaches: { open, agreements }`).

Every change is audited with the app's and workspace's ids, in the obligations class: `add_agreement_sla`, `retire_agreement_sla`, `record_sla_breach`, `resolve_sla_breach`.

A breach is told to both parties' firms on their webhooks and notices: `agreement_sla.breached`, with the commitment, the metric and target, the measured value, the period and the side that recorded it.

## Agreements in Studio

Agreements appear in three places in Mynt Studio: an app's **Agreements** tab, the **Licences** page and the **Audits** page. See [Licences](studio.md#licences) and [Audits](studio.md#audits) for the pages as a whole.

### The app's Agreements tab

- It lists what production needs: each licence provider and product, signed and in force or why not. Owners and admins get a **Propose agreement** shortcut pre-filled with that licence provider and product.
- It flags an app in production that lost an agreement.
- Each agreement row has labelled actions for owners and admins, each opening a sheet:

| Action | When |
| --- | --- |
| **Accept**, **Decline** | A proposal the other firm made |
| **Sign** | Accepted, your side not signed yet |
| **Withdraw** | Your own proposal, with a reason |
| **End agreement** | Accepted or signed, with a reason |

The app's **Products** tab and the **Promote to Production** sheet show the `program_agreements` check with the same rows and shortcut.

### The Licences page

The Licences page (`/licences?tab=business-agreements|msa|sla|audit-obligations`) is where both sides work on their agreements. It is in the sidebar for builders and for licence providers, even without the builder role.

It has four tabs in the page body under the header: **Business Agreements**, **MSA**, **SLA** and **Audit Obligations**. Each lists what the person's side holds:

- a licence provider sees the agreements made with its firm;
- a builder sees its selected workspace's (`list_app_agreements` with `workspace_id`);
- someone who is both sees both, each row saying its side.

The page has no row of figures and no licence table or coverage map. Licence coverage is on each product's **Compliance** tab. `/coverage`, `/licences?view=map` and the old `?tab=coverage` come back to `/licences`, and `?tab=agreements` is Business Agreements.

**Business Agreements, MSA and SLA.** Business Agreements holds program and data-sharing agreements, MSA master services agreements and SLA service-level agreements. Each is a table with:

- columns for the app, the other party, products, kind, scope, status in words, effective dates, document and actions;
- a full-width search, a Filters popover (status, kind where the tab has more than one, scope, and your side when you are on both) and a Proposed date range;
- **Import** (disabled: agreements are made here) and **Export CSV**;
- the tab's own **Propose agreement**, **Propose MSA** or **Propose SLA**.

Either side proposes, for one app, MSAs and SLAs too: a builder to a firm sponsoring the app's products, a licence provider to a workspace whose app builds on them. A licence provider may start from one of its templates. The other side uses **Accept** or **Decline**. While the proposal is still proposed, the proposer may **Withdraw** it or use **Change scope** (`update_agreement_scopes`) to change what it covers. Then both **Sign**. **End agreement** ends it.

**Review agreement.** A row opens **Review agreement**: a card with the terms and the document, the labelled actions for the row's side, then tabs, each a table.

| Tab | On | Shows | Actions |
| --- | --- | --- | --- |
| **Products** | Every agreement | The products it covers | |
| **Signatures** | Every agreement | Who signed | |
| **Commitments** | An SLA | Metric, target, window, source, remedy, status | **Add commitment** before it is signed; **Record breach** and **Retire commitment** on each |
| **Breaches** | An SLA | Period, measured value, who recorded it, status | **Resolve breach** |

A licence provider also has **Add audit requirement** on an open program agreement of its firm.

**Agreement templates.** Under the MSA table, a licence provider has its firm's **Agreement templates**: name, version, attached to, file, SHA-256, in use or retired. **Upload agreement template** opens a sheet (name, licence, file, signature placement, field placement notes), and **Retire** retires a version.

**Audit Obligations.** This tab shows the oversight audits under program agreements (`list_agreement_audits`): requirement, agreement, app, kind, cadence, due date, status in words with Overdue, and findings. It only shows them, and so does an audit's sheet there.

### The Audits page

Oversight audits are acted on from the **Audits** page's **Agreement audits** tab.

### Signing in Studio with e-signature

With [e-signature](#e-signature) configured, **Sign** on a program agreement opens the signer's embedded signing page in a sheet instead of recording a signature by hand. Once both have signed, each side's row offers **Download signed copy** and **Download certificate**.
