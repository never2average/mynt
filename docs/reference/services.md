# Services

This file covers services: the third kind of thing built on Mynt, beside apps and financial products. It is for builders who hold the vendor role and want to build a service on Mynt and list it in the Marketplace, and for Mynt admins who define service types.

See also: [Vendors and the marketplace](vendors-and-marketplace.md), [Apps and builds](apps-and-builds.md), [Mynt Studio](studio.md), [Roles and tools](roles-and-tools.md), [Platform administration](platform-admin.md).

## The three kinds

| Kind | What it is | Who uses it |
| --- | --- | --- |
| App | An app for customers, built on financial products | Customers |
| Financial product | A regulated product composed from primitives | Apps |
| Service | A service other builders plug into their products, listed in the Marketplace | Builders |

A service answers one of Mynt's standard service types (identity verification, a bureau report, a score) in one region. A vendor can still serve a service type from its own endpoint, as before (see [Offerings and conformance](vendors-and-marketplace.md#offerings-and-conformance)). A service is the same offering built, verified and hosted on Mynt.

## How a service is stored

A service is an app record of kind `service` (`apps.kind`, `app` by default), with exactly one vendor offering made with it (`vendor_offerings.app_id`, one per service).

- Builds, hosting, stages and workspaces reuse it by its id. `start_build`, `deploy_app`, `undeploy_app`, `get_promotion_checks`, `promote_app` and `demote_app` take a service's id as `app_id`.
- It belongs to a workspace, and to the firm of the person who created it.
- It has one service type and one region, no products, and is never published as an app experience.
- `list_my_apps` returns it with `kind: "service"`. `list_my_services` returns services only.

## Creating a service

`create_service` takes a name, a description, a service type and a region, and optionally a workspace, a price per call, service-level notes and the firm's licences it relies on.

It needs:

- the vendor role. A Mynt admin grants it; builders do not get it by themselves;
- a firm. The service is offered by the caller's firm;
- to be an owner or admin of the workspace it goes in.

Service types stay admin-defined (`list_service_types`). The Mynt Ramp's service types are not built as services.

The answer is the service as `get_service` returns it, with what to do next. The signing secret is never in it.

### Asking for a service type

When no service type fits, `request_service_type` asks Mynt's admins for one:

```json
{
  "name": "Income verification",
  "what_it_does": "Confirms a customer's stated income against payroll data.",
  "example_input": { "full_name": "Asha Verma" },
  "example_output": { "verified": true }
}
```

- `region` is optional (`US` by default). Each example is one JSON object under 8 KB. A person may have ten requests waiting.
- `list_service_type_requests` shows each request's status: waiting for Mynt, defined (with the service type's key) or declined (with the reason). Builders and vendors see their own and their firm's; admins see everyone's.
- An admin defines the service type from the request with `define_service_type { service_type, from_request }`, or declines it with `decline_service_type_request { request_id, reason }`.
- Each step is audited (`request_service_type`, `define_service_type` with the request's id, `decline_service_type_request`).

## The contract a build reads

`get_service_type_contract { key, region }` returns everything an endpoint for a service type implements, as one JSON document:

- the input, params and output JSON Schemas;
- the signature rule;
- the request and response shapes;
- fixture requests valid against the input schema, and an example output;
- the path a service answers at.

Nothing in it is secret. A build reads the same document three ways:

| Where | How |
| --- | --- |
| The MCP tool | `get_service_type_contract` |
| The runtime API | `GET /v1/service_types/<key>/contract?region=<region>`, with the build's sandbox key |
| The build's job | `job/service-contracts/<key>.json`, named in `job/build.json` as `service.contract` |

## What the coding agents build

A build for a service starts from `core/workspaces/coding-build/templates/mynt-service/`:

```sh
python3 scripts/scaffold_app.py <dest> --service <contract.json>
```

It is one Compose project with two parts.

- **`api/`** serves `POST /mynt/services/<service type key>`. `vendor-service.ts` verifies `Mynt-Signature`, checks the input against the contract's input schema, calls `handleService`, checks the output against the output schema and answers. `handle-service.ts` holds the one function the builder writes: `handleService(input) → output`.
- **`web/`** is a status page. A service has no customer screens, no SDK and no mobile part.

The template ships a unit test for the signature and the schemas (`npm test`). CI scaffolds a service from the contract of a shipped service type, runs those tests, then starts the service and runs Mynt's own conformance cases against it.

The app starter (`templates/mynt-app/`) is unchanged: an app never serves a service type.

## The endpoint and the signing secret

**The endpoint is derived, never typed.** It is the service's hosted address plus `/mynt/services/<service type key>`. Mynt sets it each time the service is put online. `update_vendor_offering` refuses `test_base_url`, `live_base_url` and `requires_credential` on a service's offering.

**The signature is the only authentication.**

- Mynt signs each request with `Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
- The service answers `401` to a signature that doesn't verify or a timestamp more than 300 seconds from now, and compares in constant time.
- Mynt's conformance and live calls go straight to the hosted address. They carry no credential and no app key.
- The app key Mynt's hosting adds at its edge is added only to a hosted project's own calls out to Mynt's address. It is never on a call from Mynt to a service, and the endpoint must never ask for one.

**The signing secret reaches the service only as a hosted setting.**

- The build that serves has one signing secret, sealed with `MYNT_VAULT_KEY`.
- `deploy_app` hands it to the service as `MYNT_VENDOR_SIGNING_SECRET`, in the deploy job's environment, never in the job's text. It is scrubbed from a failed deploy's output.
- It is never shown: not by `create_service`, `get_service`, `list_my_offerings`, nor to the browser. It is never in the repository, and never in a run's transcript.
- Every subscriber's calls are signed with it. `reveal_subscription_secret` and `rotate_subscription_secret` refuse a service's subscriptions and say why.
- A new build that goes online beside the serving one gets a new secret of its own (see [A new build and conformance](#a-new-build-and-conformance)).

Mynt's [outbound safety](vendors-and-marketplace.md#outbound-safety) rules apply to a service as to any vendor: HTTPS on port 443, and never a private, loopback or reserved address. A hosted address is the hosting provider's, not Mynt's own.

### Hosting a service needs direct hosting

A service is hosted under direct hosting only (see [Direct hosting on Freestyle](apps-and-builds.md#direct-hosting-on-freestyle)). On a Mynt that hosts through its gateway, `create_service` and `deploy_app` for a service refuse and say why. Nothing is half-created or half-deployed.

Gateway mode cannot host a service, for four reasons in how it works:

- A service is a Compose project, and gateway mode runs single-container apps only.
- The VM's agent is a script fixed when the VM first booted. It starts each app with its Mynt key and Mynt's address and nothing else, so there is no way to hand over the signing secret.
- Mynt never learns that a build is running there, so it cannot test a build the moment it answers.
- It has one VM per workspace and one container per app, so a new build cannot go online beside the one serving.

## Stages

A service moves through the same stages as an app, in the same sidebar folders.

| Stage | Means |
| --- | --- |
| Idea | A draft. Its offering exists and is not listed |
| Staging | Built and online. Mynt runs its conformance test; practice runs are for information. Once a build has passed, it is open to sandbox testing by its offering id |
| Production | Listed in the Marketplace, and live-subscribable |

Production is the listing. `promote_app` to production lists the offering, and `demote_app` back to staging unlists it. `update_vendor_offering { listed }` is refused on a service's offering.

### Testing a service in Staging

A service in Staging whose build has passed Mynt's conformance test is **in testing**: builders can subscribe to it and call it in the sandbox, before it is listed.

- **By its offering id only.** It is never in the Marketplace list. Its builder gives the offering id to whoever should test it (`get_service` returns it as `testing.offering_id`, and the Studio shows it). `list_vendor_offerings { offering_id }` shows that one offering, marked `availability: "in_testing"` and `sandbox_only: true`.
- **Subscribing.** `subscribe_vendor_service { offering_id }`, as for a listed offering: the same licence prerequisites, and the vendor's standard terms accepted by version when it has any on file.
- **Sandbox only.** Sandbox sessions call it. Live sessions never do: `set_subscription_live` refuses and says why, and a live call is refused whatever the subscription says.
- **Promotion carries subscribers over.** Moving the service to Production lists it. The same subscriptions go on working in the sandbox and can then be turned live with `set_subscription_live`.
- **Moving back.** `demote_app` to Staging stops live calls and takes it off the list. Its subscriptions stay, sandbox only again.

`list_my_vendor_subscriptions` shows each subscription's `availability` (`listed` or `in_testing`, with the words "In testing: sandbox only until its builder moves it to Production").

### Promotion checks

`get_promotion_checks` computes them from Mynt's own records. Moving to staging uses the same three checks as an app (the build verified, its audit, and that it runs).

Moving to production uses a service's own checks, in this order:

| Check | Passes when |
| --- | --- |
| Conformance passed on the build that is online | Mynt's latest conformance run passed against the build Mynt's hosting runs |
| Standard terms set, with their scope | The offering has standard terms that name what they cover |
| Licence verified by Mynt | A verified licence in force is named on the offering, or the service type needs none |
| Latest build verified by Mynt | A build passed Mynt's verification in a clean sandbox |
| Independent audit passed | The build's independent audit found no critical or high issue. A build with no audit warns |
| No open blocking audit findings | The audit left no critical or high finding open |
| Healthy on Mynt's hosting | The verified build runs on Mynt's hosting |

A service has no checks for target states, licence coverage by product, sponsor program agreements, webhooks or admin sign-off.

## A new build and conformance

Every build that goes online is tested before it serves anyone, and subscribers never wait for that.

**Who puts a build online.** Only an owner or admin of the service's workspace, at the firm that offers it. A build put online is handed a signing secret and, once it passes, receives subscribers' requests, so being a member of the workspace is not enough. The same people take it offline (`undeploy_app`), restart it (`restart_app`) and run commands in it (`app_run`). Every member reads its status and logs.

### When a build is serving

While a build serves subscribers (the offering is `conformance_passed` or `listed`), a new build never replaces it directly.

1. `deploy_app` puts the new build online **beside** the serving one: a second copy, on a VM and at an address of its own. The offering keeps its endpoint, its secret, its status and its place in the Marketplace. `get_service` shows the new build as `new_build`.
2. When the new copy answers, Mynt runs its conformance test against it, with nobody asking.
3. **A pass switches.** The offering's endpoint, its signing secret and the hosted copy change in one transaction. The service never leaves the list. The copy that served until then is removed 15 seconds later, so calls already in flight to it finish. Audited as `service_build_switched`.
4. **A failure changes nothing for subscribers.** The new copy is removed, VM and address. The serving build keeps serving and stays listed. The failed test is kept with its cases and transcript, and shown in `get_service` as a run with `new_build: true`, `switched: false` and its `outcome` in words. Audited as `service_build_not_switched`. A build that never starts is handled the same way.

For a service in Production, passing conformance is not enough to take over. The new build must also meet the other checks a promotion to Production runs, read for that build: verified by Mynt, no critical or high audit finding, standard terms with their scope, and the licence. A build that passes conformance but fails one of these is removed like a failed one, and its run says which check stopped it.

One new build is tested at a time. Putting another online replaces the one still being tested. Taking the service offline, or archiving it, removes it.

**The new copy's signing secret.** The new copy gets a new secret of its own, not the serving copy's. Code Mynt has not tested yet never holds the secret that authenticates calls to the build subscribers rely on, so a build that leaks its settings cannot be used to forge requests to the serving one. Each build's secret ends with it. This costs nothing in availability: the endpoint and the secret are stored, switched and read together, so every call is signed for the copy it is sent to. The secret reaches the copy as before: a hosted setting in the deploy job's environment, never returned, scrubbed from output.

**The address.** Each copy answers at an address Mynt derives for it, so the service's address changes when Mynt switches to a new build. Nobody types or stores it: Mynt calls the offering's endpoint, which it sets itself.

**If the host does not confirm a removal.** A VM the hosting provider did not confirm as deleted stays on Mynt's record and is tried again at each deploy and on the usage worker's rounds.

### When nothing is serving

A first build, or one put online while the offering is a draft, offline or suspended, goes online in place.

1. `deploy_app` points the offering at it as a draft ("Needs conformance"). An admin's suspension stays as it is.
2. When the build answers, Mynt runs its conformance test itself. It is recorded with no person as its runner, and audited as `service_conformance_after_deploy`.
3. A pass makes the offering `conformance_passed`. For a service in Production it makes it `listed` again, when the build also meets the other production checks above. If it does not, `run_conformance` answers with `not_listed`, the checks that stopped it.
4. A failure leaves it a draft. `run_conformance` runs the test again by hand.

Conformance is always Mynt's own, run from outside the service. Nothing the service or a coding agent runs counts.

### Transcripts

Mynt keeps each run's transcript: for every case, the request it sent (method, path, headers, body), the answer (status and body) and what it expected. This covers real runs, tests of new builds and practice runs. `get_service` returns it on each run as `transcript`.

- Requests are Mynt's fixtures, never a customer's data.
- The signature's digest is left out (`v1=<redacted>`). The signing secret, any credential and anything shaped like one are replaced before the transcript is stored, including in the service's own answers.
- The path is kept, never the address.
- An answer over 8 KB is not kept; the transcript says how long it was.
- A run from before transcripts were kept has `transcript: null` and a `transcript_note` saying so.

## Offline, archive and removal

- **Offline.** `undeploy_app` suspends the offering with the reason ("isn't online"), and products that hand off through it drift. Only an owner or admin of its workspace, at its firm, takes it offline. It is not an admin's suspension: an admin cannot lift it, and it comes back when the service is put online again and passes. A new build being tested beside it is removed too.
- **Archive.** `archive_service { service_id }` takes the offering off the Marketplace and stops calls at once. A new build being tested is removed. Its builds, conformance runs, terms and agreements stay. `archive_service { archived: false }` restores it as a draft, to be put online and tested again. Only an owner or admin of its workspace, at its firm, archives or restores.
- **Removal.** An admin's `remove_app` refuses a service that isn't archived, because suspending its offering as a side effect would pause other firms' products. Once archived, removal unlinks the offering and keeps it as the vendor's and its subscribers' record.

## Reading a service

`get_service { service_id, days? }` returns one service, whole, to any member of its workspace:

| Part | Holds |
| --- | --- |
| `stage`, `archived`, `offering`, `hosted` | Where it stands, and the offering's status in words |
| `contract` | The service type's contract, with the input, params and output as field tables (`field`, `type`, `required`, `description`) and the endpoint in full once it is online |
| `new_build` | A new build online beside the serving one while Mynt tests it, or `null` |
| `testing` | Whether builders can test it in the sandbox by its offering id, with the id and how |
| `conformance` | Real runs, tests of new builds that did not take over, and practice runs, newest first, each with its cases, its transcript and the build it tested; whether a test is needed; the build the standing pass ran against |
| `terms` | The current standard terms and every version Mynt knows |
| `subscribers` | Each subscribing firm and app, the terms version accepted, since when, live or sandbox, and the agreement's status |
| `reliability` | Calls, error rate and incidents over the window, from Mynt's own records |
| `activity` | Builds, deploys, stage moves, conformance runs, switches to a new build and terms changes |
| `checklist`, `progress` | What is left, in order |

`subscribers`, `checklist` and `progress` are for the offering firm's own people and Mynt's admins. A member of the workspace who belongs to another firm gets `subscribers: null`, an empty checklist and `firm_only` saying so.

### Reliability

Reliability is read from Mynt's count of calls per subscription and day (`vendor_usage`), its conformance runs and the audit log.

- `calls` and `error_rate` are `null`, with `not_measured` saying why, when nobody has called the service in the window. They are never shown as 0.
- `response_time_ms` is `null` for subscribers' calls: Mynt records whether each call succeeded, not how long it took. `in_last_conformance_run` gives the median and maximum of Mynt's own timed conformance requests.
- `incidents` lists failed conformance runs, new builds that did not take over, times the service went offline, suspensions and archiving.

### The checklist

| Step | Done when |
| --- | --- |
| `vendor_role` | The reader holds the vendor role at the service's firm. Otherwise: ask a Mynt admin |
| `licence` | Only when the service type needs a vendor licence: a verified one is named on the offering |
| `app_online` | The service is online and its offering points at it |
| `service_endpoint` | Mynt's conformance test reached the endpoint and passed. Mynt cannot see inside a build; a `404` at the path says the endpoint isn't in it |
| `practice` | For information, never counted |
| `conformance` | The build that is online passed |
| `terms` | Standard terms with their scope are on file |
| `listed` | The service is in Production |

`get_vendor_onboarding` shows the same steps for a service's offering, with `service` naming it.

## In the Marketplace

Subscribers see a service like any offering: the vendor's name, its terms, its conformance result. Only the vendor's own firm is told that an offering is one of its services built on Mynt (`service` on `list_my_offerings` and on its own rows of `list_vendor_offerings`).
