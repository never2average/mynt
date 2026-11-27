# Workspaces and sign-in

This file covers workspaces (the teams that own apps), their members, what a workspace owns, how apps move between stages, the audit trail, profit and loss, and who may sign in to Mynt at all. It is for builders and their teams, and for Mynt admins.

See also: [Roles and tools](roles-and-tools.md), [Apps and builds](apps-and-builds.md), [Agreements](agreements.md), [Mynt Studio](studio.md), [Sign-in with Clerk](operations.md#sign-in-with-clerk).

## Workspaces

Builders build apps in workspaces. A workspace is a team.

- Every app belongs to one workspace.
- Everyone in the workspace may see and work on its apps and their builds: edit, check and publish them; start, steer, finish and stop builds; use their sandboxes; deploy and run them; and manage their keys, webhooks, releases, journeys and metrics.
- Nobody else can. To anyone outside, the app and its builds don't exist ("No app of yours with id …").
- `owner_id` still names the app's creator. It no longer decides who may touch the app.

A workspace is not a firm. A firm (an entity) is a regulated legal party. A workspace is only who works on which apps.

| Tool | Does |
| --- | --- |
| `list_workspaces` | The workspaces you belong to, your role in each, and how many members and apps each has |
| `create_workspace` | Makes a new workspace. You are its owner |
| `rename_workspace` | Owners and admins rename a workspace |
| `list_workspace_members` | A workspace's members and their roles. Owners and admins also see the invites still open |
| `archive_workspace`, `unarchive_workspace` | Owners archive a workspace, or undo it (see [Archiving a workspace](#archiving-a-workspace)) |
| `relink_workspace_org` | An owner gives a frozen workspace a new organization (see [What the provider changes, Mynt follows](#what-the-provider-changes-mynt-follows)) |

## Members and invitations

### Workspace roles

A member of a workspace is an `owner`, an `admin` or a `member`. These are workspace roles, separate from Mynt's own roles.

| Workspace role | May |
| --- | --- |
| `member` | Build, invite members, and put builds online for apps in Idea and Staging |
| `admin` | Also invite admins, rename the workspace, change roles, remove people, create live API keys and rotate keys, move apps between stages, and for an app in Production put a build online, take it offline, restart it and run commands in it |
| `owner` | Also make, unmake or remove owners, and invite one |

A workspace always keeps an owner who can manage it: one with a builder's role on Mynt. Its last owner can't leave, be demoted or be removed. Every change is in the audit log.

### Inviting

Any member invites an email address into a workspace they are in with `invite_to_workspace`. The invite names:

- a workspace `role` (members invite members only);
- a `mynt_role`: `developer` or `user`. A `user` invite can only be for a member.

Each person may send 20 invites a day. On a server without an identity provider's organizations, Mynt doesn't email anyone; with them, the provider emails the invitee (see [Organization invitations](#organization-invitations)).

### Invitations are answered by the invitee

Nobody joins a workspace by signing in.

- The person signed in with that verified address sees the invite with `list_my_invitations`, with what accepting would let them do.
- They answer it with `accept_workspace_invite` or `decline_workspace_invite`.
- An unanswered invite lapses after 30 days.
- Its sender, or an owner or admin, can withdraw it with `revoke_workspace_invite`.

Owners and admins manage members with `change_member_role` and `remove_workspace_member`. A member leaves with `leave_workspace`.

### Mynt admins on any workspace

A Mynt admin can manage any workspace's members without being one. In Studio this is the platform admin's Members tab.

| Admin tool | Runs the same code as |
| --- | --- |
| `admin_invite_workspace_member({ workspace_id, email, role?, mynt_role? })` | `invite_to_workspace` |
| `admin_change_workspace_member_role({ workspace_id, user_id, role })` | `change_member_role` |
| `admin_remove_workspace_member({ workspace_id, user_id })` | `remove_workspace_member` |
| `admin_revoke_workspace_invite({ invite_id })` | `revoke_workspace_invite` |

They act with an owner's authority, under the owners' rules:

- a frozen workspace refuses invites;
- a workspace never loses its last owner;
- a removal or a demotion to member cuts access as described below;
- someone new gets onto Mynt as with any workspace invite.

When the workspace is an organization of the identity provider, the organization is invited, changed or left in the same step and first, so it stays in sync. The invitation is the provider's, sent without an inviter when the admin isn't in the organization, which the provider allows. A role change or removal is made there before Mynt's own, and nothing changes if the provider refuses.

Each is audited under the owners' tool's action name with `by_admin: true`.

### Getting onto Mynt through a workspace invite

An open workspace invite lets someone new sign in to Mynt, as a user (Mynt's `consumer` role) and nothing more.

- It is recorded as Mynt's own invite, from the workspace's inviter. The identity provider's allowlist is kept in step, as for an admin's invite.
- Accepting a `developer` invite then adds `developer`, but only to an account that is a user's alone or has no roles yet. It never adds it to a firm's account (vendor, licence provider or liquidity provider) or a Mynt admin's, and never past roles a Mynt admin set after the invite was sent.
- A `user` invite adds nothing. Such a member can't build until they are a developer.
- Someone a Mynt admin revoked stays out, and Mynt admins can revoke anyone let in this way.

Withdrawing an invite, or letting it lapse, withdraws the Mynt invite it made, but only if its person never signed in and nobody changed that invite since (each change counts up its revision). Someone who signed in only to decline it, and belongs to no workspace, is taken back off Mynt the same way.

### Leaving cuts access at once

When someone leaves or is removed:

- **API keys.** Keys they created for the workspace's apps, or whose current secret they were handed by rotating it, are revoked. A hosted app's runtime key belongs to the workspace (it is sealed and never shown), so a deployer leaving never stops the app.
- **Webhooks they made** stop getting deliveries. An owner or admin can turn one back on with `enable_webhook`, confirming its URL or giving a new one, and getting a new secret.
- **Webhooks whose secret they were handed** get a new secret nobody holds yet. The workspace's audit trail and `ops_status` say so, so an owner or admin rotates it and gives the receiver the new secret.
- **Repositories.** Mynt's automatic access to the apps' managed repositories (their approved connections) goes.
- **Invites.** Invites they sent that nobody has answered are void, so nobody comes back through one. An invite is also void at acceptance if its sender is no longer in the workspace or no longer may invite to that role.
- **Builds.** Their running builds stop and the sandboxes they reopened close.
- **Solana programs** they reserved for the workspace's apps pass to its longest-standing owner.
- **VM logins.** Their logins to the workspace's hosting are revoked. That also happens when an owner or admin is made a member, recorded and retried the same way.

All of it is in the audit log (`workspace_offboard`).

### How offboarding is carried out

- It is recorded first, with the VM logins that were theirs at that moment. Each step is idempotent and, once done, isn't run again.
- A step that fails (a provider is down) is retried with backoff, up to 10 times. Retries are ordered by attempts first, then due time, so one that keeps failing holds up nothing. After 10 it is marked failed and `ops_status` names it. A Mynt admin can retry any at once with `retry_offboard`.
- If they are back in the workspace as an owner or admin before it finishes, it is superseded: nothing granted to them since is revoked. Back only as a member, the rest is superseded but the VM logins of their admin days are still revoked, since a member holds none.
- Only the logins recorded as theirs are revoked, each once the provider confirms. If which logins are theirs can't be read when they leave, the VM step reads it again on each retry and never takes that for none.
- A new VM login is never given while the last one can't be ended (the provider not confirming), so no login is left behind unrecorded.
- A login the provider no longer has (deleted in its dashboard, or by a revoke whose answer was lost) counts as already ended. It never locks anyone out or holds up an offboarding.
- A build started while its builder was being removed is stopped as soon as it exists. A build stopped while its sandbox was being made never comes back to life: the sandbox is torn down.

## What a workspace owns

### New apps

`create_app` takes a `workspace_id` the caller belongs to. Without one, the app goes in the workspace the caller created, never in one they were invited into. If they have none, one is made for them (at most one each). With several of their own, they must say which.

### Builds

A build for an app is the workspace's.

- Every member sees it (`get_build`, activity, files, diff), can stop or finish it, and can start their own from it (`continue_from`).
- Someone who leaves loses it at once.
- Steering it or reopening its sandbox stays with whoever started it, since it spends their budget.
- Running commands in its sandbox or opening its editor needs the caller's own approved connection to the build's repository, because the sandbox holds a credential for it. That doesn't apply when the repository is the app's Mynt-managed one, or there is none.
- A build for no app stays its starter's.
- Spend counts against the starter's monthly budget and, when set, the workspace's. There, a running build counts at its whole cap.

### Repositories in a workspace

- Connections and their admin approvals stay per builder.
- Mynt's managed repositories need none: a teammate building or deploying the app gets access as its builders do.
- The app's own repository (`set_app_repository`) needs each teammate who builds or deploys from it to connect it themselves (`connect_repository`), approved like any connection.

### Hosting for the workspace

Hosting is the workspace's.

- An owner or admin turns it on (`request_hosting` with `workspace_id`).
- Every app of the workspace runs on it, whoever deploys it, fetched through the deployer's own approved connection or the managed repository.
- Any member can check its apps and read their logs. Any member can also deploy, run commands in, restart and undeploy an app in Idea or Staging.
- For an app in Production, only owners and admins deploy, undeploy, restart and run commands in it, and a build goes online only if it passes the production checks about the build. See [Who puts a build online](apps-and-builds.md#who-puts-a-build-online).
- Only owners and admins get VM logins (`vm_access`).

A builder's own hosting from before workspaces keeps the apps it runs until they are deployed again. `hosting_status` lists them with `legacy: true`, and logging in to it needs owner or admin standing in every workspace whose apps it runs.

### Rotating secrets

Rotating the secrets of API keys and webhooks, and creating live keys, is for owners and admins. Mynt records who received each current secret.

### Sandbox files

Sandbox files are read only inside the app's directory: no absolute paths, no `..`.

### Product access

Product access is judged for the app. The newest product-access request for that product and app decides, whoever in the workspace made it. An invitation (for no app) counts only for the person invited.

### Existing apps

When a Mynt server first starts with workspaces, each builder with apps gets one workspace, "<their name>'s workspace", which they own and which holds all their apps. Nothing else changes for them.

## Stages and promotion

### Stage

`list_my_apps` gives each app a `stage`: `idea`, `staging` or `production`. A new app starts as an `idea`. Its stage changes only by promotion and demotion, never by its builds or hosting on their own.

Apps that existed before promotions kept the stage Mynt derived for them then: `production` if published and running on Mynt's hosting, `staging` if it had a build Mynt verified or a deployment that wasn't live, else `idea`.

### Promotion

An app moves one step at a time, `idea` to `staging` to `production`, after checks Mynt computes itself from its own records: the builds it verified, the audit it ran, its hosting's state, licences and sponsorships, keys, webhooks, the mainnet program gate and Mynt admins' sign-offs. Nothing the app or an agent reports counts.

| Tool | Who | Does |
| --- | --- | --- |
| `get_promotion_checks({ app_id, to_stage })` | Any member | Returns the checks for the next stage up |
| `set_app_target_states({ app_id, states })` | Owners and admins | Sets the US states the app serves (`us-ny`, …, `us-dc`) |
| `promote_app({ app_id, to_stage })` | Owners and admins | Runs every check again and moves the app up |
| `demote_app({ app_id, to_stage, reason })` | Owners and admins | Moves the app one step down |
| `request_promotion_signoff({ app_id })` | Owners and admins | Asks a Mynt admin to sign off a production promotion, or a newer build of an app already in Production |

In a frozen or archiving workspace, `promote_app`, `demote_app` and `request_promotion_signoff` are refused until an owner relinks or unarchives it.

### Reading the checks

`get_promotion_checks` returns:

```json
{
  "app_id": "…",
  "from_stage": "staging",
  "to_stage": "production",
  "checks": [{ "id": "build_verified", "label": "…", "status": "pass", "detail": "…", "fix": { "label": "…", "href": "…", "tool": "…" } }],
  "can_promote": false,
  "needs_admin_signoff": true,
  "signoff": { "status": "none" }
}
```

- `to_stage` must be the next stage up.
- `status` is `pass`, `fail`, `warn` or `pending`. Pending means Mynt can't tell yet: it blocks like a fail, and is never shown as a pass.
- `fix` is optional: `{ label, href?, tool? }`, where `href` is a Studio path.
- `can_promote` is true when every check passes, or warns where the warning is advisory. Every staging check's warning is advisory. In production only the warnings of `build_verified`, `audit_passed` and `audit_findings` are (`ADVISORY_PRODUCTION_CHECKS`); any other production warning blocks.

### Checks to move to staging

| Check | Passes when |
| --- | --- |
| `build_verified` | The latest build passed Mynt's verification in a clean sandbox. Pending while one runs; a warning when a newer build failed |
| `audit_passed` | Mynt's independent audit found no critical or high findings, or none ran on that build |
| `app_runs` | The app is healthy on Mynt's hosting, if deployed there. Pending while deploying; a failure when stopped or its hosting isn't running; a warning when not deployed or running an older build |

### Checks to move to production

Production needs the staging checks, with these differences and additions.

| Check | Passes when |
| --- | --- |
| `hosting_healthy` (in place of `app_runs`) | The app is running on Mynt's hosting, and the build it runs is the latest verified build that every other check and the sign-off are about. Anything else fails |
| `audit_passed` | As for staging, but a warning when no independent audit ran, and a failure then when the app needs sign-off |
| `licences` | Target states are set (none fails). In each of them, every product the app uses is published, its sales are not paused, and it is covered by a licence in force for its action, under an approved sponsorship where a licence provider provides it |
| `program_agreements` | A signed program agreement is in force today with the licence provider sponsoring each product the app uses, covering that product. See [Production needs program agreements](agreements.md#production-needs-program-agreements) |
| `webhooks` | Each webhook is on, its secret is held by a current member, and its last delivery did not fail. Pending until a delivery has reached it, for example from a sandbox hand-off |
| `audit_findings` | The newest audited build has no critical or high findings, even one newer than the verified build. With no independent audit there are none to read: a warning, or a failure when the app needs sign-off |
| `program_gate` | When the app has Solana programs or its verified build carries some: each is on mainnet, deployed through the program gate, with no open vulnerability flag. Pending while a review runs |
| `admin_signoff` | Only when `needs_admin_signoff`: a Mynt admin approved this build |

### Promoting and demoting

`promote_app` runs every check again inside one transaction holding the app's lock, and refuses unless `can_promote`. A change since someone looked is caught then.

- The audit trail records `app_promoted` with the build, its source hash, the build its hosting ran and the checks it passed. The same is kept on the app's stage record.
- Members don't promote. They see the same checks and ask an owner or admin.

`demote_app` moves the app one step down, recorded as `app_demoted` with the reason.

- Demoting a production app is refused while it has active live API keys. The caller revokes them first (`revoke_api_key`, the hosted runtime key too). Demotion never revokes them itself, so nobody loses live access by accident.
- It then unpublishes the app (`unpublished: true`).
- Hosting and webhooks stay as they are.

### Production gates real money

Only an app whose stage is `production` may:

- hold a live API key (`create_api_key` and `rotate_api_key` for a live key);
- make a live runtime API call, with a live key or a client session minted with one (`403 app_not_in_production` otherwise);
- publish (`publish_app`, `release_app`).

Ideas and staging apps run on sandbox keys. Each refusal says "Promote this app to Production first".

`deploy_app` gives a hosted app a live runtime key only when it is in production and published, else a sandbox one. So a production promotion doesn't ask for a live key: live keys come after it.

Live webhook events (hand-offs completing, failing, reversing) can only follow live calls, so they come from production apps. One that follows after a demotion (a reversal of an earlier live transfer) is still delivered, never dropped.

Live keys are issued and rotated under the app's stage lock, the same one promotion and demotion take, so a new live key and a demotion can't interleave.

When this gate arrived, existing apps were placed once, each move recorded in the audit trail as `app_stage_grandfathered` with why:

- an app live right then (published, with an active live key or an unexpired real customer session) went to production, so nothing live broke;
- an app live before but not then (a live key, even revoked; published; real customers' sessions or hand-offs) went to staging if it was an idea, so it reaches production only through `promote_app`'s checks;
- the rest stayed as they were.

### Production sign-off

A production promotion needs a Mynt admin's sign-off when the app moves value:

- it has Solana programs beyond devnet, or its verified build carries programs; or
- a product it uses is covered by a firm with an approved money rail.

How it works:

1. An owner or admin asks with `request_promotion_signoff({ app_id })`. The request is for the latest verified build. For an app in Staging, only once that build is the one running on Mynt's hosting. Asking again for the same build returns the open request.
2. Mynt admins see requests with `list_promotion_signoffs`.
3. A Mynt admin decides with `decide_promotion_signoff({ id, approve, note? })`. An admin never decides one they asked for themselves, and never one for an app in a workspace they are a member of, in any role.

A sign-off is for one verified build (its id and source hash) and the basis that made it necessary. The `basis` is the app's programs beyond devnet, whether its build carries programs, and the ids of the approved money rails behind its products. All of it is recorded with the sign-off.

- A newer verified build, or a change to that basis without one, makes `signoff.status` `none` again and needs a new sign-off.
- A request whose build or basis changed before it was decided can't be decided: it is marked superseded.

**After promotion.** The sign-off still goes with the build. For an app in Production that moves value, `deploy_app` puts a newer build online only once a Mynt admin has signed off that build, so there the order is the other way round: an owner or admin asks first, for the latest verified build, before it is hosted, and deploys it once it is approved. A build signed off earlier can be put online again without a new one. See [Who puts a build online](apps-and-builds.md#who-puts-a-build-online).

`signoff` is `{ status: none | requested | approved | rejected, by?, at? }`.

## Attention

### What needs attention

`get_workspace_attention({ workspace_id })` lists what needs attention for the caller's role in that workspace, most severe first. It is for members only, and for that workspace only.

```json
{ "items": [{ "id": "…", "kind": "build_failed", "severity": "high", "title": "…", "detail": "…", "href": "…", "at": "…" }] }
```

`severity` is `high`, `medium` or `low`.

Everyone in the workspace sees:

| Kind | Meaning |
| --- | --- |
| `workspace_frozen` | High. Its organization was deleted in the identity provider |
| `workspace_archiving` | High. The workspace is being archived |
| `build_failed`, `build_blocked` | An app's latest build in the last 14 days ended that way, for example because its repository access was withdrawn |
| `promotion_checks_failing` | A production app's production checks fail now. A program agreement that ended or expired is one cause; so is having no target states, or products that lost licence coverage |
| `app_agreement_update` | The other firm accepted, declined, signed or ended one of its apps' agreements in the last 14 days |
| `licence_expiring` | A licence behind its products lapses within 30 days |
| `agreement_audit_overdue` | High. An oversight audit under one of its apps' agreements is past its due date and not closed |
| `agreement_sla_breach` | Medium. A service level under one of its apps' service-level agreement (SLA) agreements was missed and the breach isn't resolved yet |
| `app_agreement_proposed` | Medium for owners and admins, low for other members. A licence provider proposed an agreement for one of its apps, waiting for an answer. Its link opens Licences, Business Agreements |
| `repository_approval_pending` | The caller's own repository connection waits for approval |

Owners and admins also see:

| Kind | Meaning |
| --- | --- |
| `join_request` | Someone not on Mynt joined its organization |
| `offboard_failed` | A step of cutting someone off failed |
| `webhook_secret_rotation` | A webhook's secret was rotated out of a leaver's reach, so its receiver needs the new one |
| `webhook_disabled` | A webhook was turned off |
| `signoff_requested` | A sign-off is waiting for a Mynt admin outside the workspace |
| `signoff_decided` | A sign-off was decided in the last 14 days |
| `signoff_stale` | An approval for an app not yet in production whose programs or money rails changed since |

Nobody in a workspace decides its sign-offs, so none is listed as waiting for the caller.

### The dashboard

`get_developer_dashboard` covers every workspace's apps, or one workspace's with `workspace_id`. It covers the last 7, 30 or 90 days (default 30), live traffic only. With `workspace_id`, `build_spend.workspace` gives that workspace's spend this month against its budget.

### The dashboard's product figures

`get_developer_dashboard` also gives `active_products`, the published products its apps use, and `licences`, the licences behind them, as `list_workspace_licences` counts them.

## Compliance and the audit trail

Three read-only tools show what a workspace's apps rest on, and a fourth lists their obligations. All are for the workspace's members only. Nothing about other workspaces appears: only "available" says that someone else's product may be sold in a state.

### Coverage by state

`get_compliance_coverage` gives each of the 50 US states and DC a status, by Mynt's own product rules: the same ones `get_product_regime` and publishing apply.

| Status | Meaning |
| --- | --- |
| `unlocked` | A published product one of the workspace's apps uses may be sold there |
| `available` | Some other published product may be sold there |
| `unavailable` | None may |

A product may be sold in a state when:

- every regulated component of it is covered in the state by a licence that is verified and in force (its validity window), counting where the regulatory model says that licence counts, under an approved sponsorship where a licence provider provides the component; and
- its sales aren't paused. A covenant breach, or anything else that drifted it, pauses them everywhere.

An unlocked state lists the firms whose licences cover it, those licences, the products, and those firms' approved money rails there (kind, direction, provider, status; never limits). A workspace whose apps use no product sees only `available` and `unavailable`.

### Licences behind the products

`list_workspace_licences` lists the licences covering those products, as the coverage counts them: firm, type, regulator, number, the states they cover them in, status and expiry. Filter by `status`, `regulator` or `state`.

### The workspace audit trail

`list_workspace_audit` is the workspace's audit trail, newest first, paged with `next_cursor`. It returns up to 100 at a time. Filter by `action`, `user_id`, `app_id`, `from` and `to`, each of the last two a real calendar date or ISO time.

It holds what happened:

- to the workspace itself: members, invites, renames, offboarding;
- to its apps, and events that name one of them, like its keys and webhooks, deploys, hosting commands and releases;
- to their builds;
- in Mynt admins' decisions on its members' connections to its apps' repositories.

Events are chosen by what they are about, never by searching text.

- Details pass through Mynt's secret scrubber. Fields named like secrets, tokens, passwords, API or private keys, authorization or cookies are hidden.
- Whom an invite went to (its email and id) is shown to owners and admins only.
- The cursor keeps the database's full timestamp precision, so events in the same instant all come back.

### Audit classes

Each event is `{ id, at, class, kind, actor, app_id?, target, summary, severity?, status?, details }`. `action` is kept, the same as `kind`.

`class` comes from one table, `core/src/audit-classes.ts`, keyed by action. An action in no list is `workspace`. `core/test/audit-classes.test.js` reads every audit action in the source and fails on one that isn't in the table.

| Class | Covers |
| --- | --- |
| `security` | Application security: Mynt's independent build audits, repository access and its checks, the mainnet program gate and its vulnerability flags, secrets revealed or rotated (including out of a leaver's reach), VM logins and container exec, the hosting kill switch, and account recovery |
| `obligations` | Financial licence obligations: licences and the firm's governance, risk and compliance (GRC) records against them, firm checks, sponsorships, covenants and their breaches, product composition and drift, target states, production sign-offs (tied to licences and money rails), governance review, and the regulatory model |
| `financial` | Financial activity: money movements and their refusals, live hand-offs, liquidity commitments, withdrawals and pool state, money rails and ramps, partner ledgers, program calls and take rates |
| `workspace` | Running the workspace: members, roles and invites, apps, builds, promotions, hosting, keys and webhooks, and settings |

`class` filters by it. Without `class` you get every event.

Three kinds of row come from Mynt's own records, not the audit log:

- `build_audit` (security): each build of the workspace's apps that Mynt's independent audit ran on, at the time the build finished. `severity` is its worst finding (`critical`, `high`, `medium`, `low` or `none`) and `status` the build's.
- `money_movement` and `handoff` (financial): live ones only, never sandbox, with what moved and how it ended (`status`). Never a customer or rail reference.

`severity` is also set where the action itself says it:

- `high` for a covenant breach, a paused product, a program review flag or withdrawn repository access;
- `medium` for a pool flag or a refused, stale or differing money movement.

Otherwise it is absent.

In Mynt Studio, the Audits page shows these classes as the tabs App security, Licence obligations, Financial activity and Workspace activity, with Agreement audits beside them (see [Audits](studio.md#audits)).

### Licence obligations

`get_workspace_obligations({ workspace_id })` lists the obligations in the regulator's own register for each licence covering a product the workspace's apps use, as `list_workspace_licences` counts them. The register is `grc.registers.obligations` of the licence type, as the regulatory model defines it.

Each is `{ licence_id, licence_type, partner: { entity_id, name }, regulator, obligation_id, title, products: [{ id, name }], status, evidence?, reason? }`.

`status` comes only from what the licence holder recorded in Mynt:

| Status | Meaning |
| --- | --- |
| `overdue` | A filing the register ties to the obligation (`obligation_ref`) was recorded overdue |
| `met` | Its obligation record says compliant |
| `at_risk` | Its obligation record says partially or non-compliant |
| `unknown`, with a `reason` | Nothing recorded, not assessed, or marked not applicable (the firm's say-so, which Mynt can't confirm) |

`evidence` says what the record says and when, and how many evidence items it has, never their text. Mynt records no due dates, so `due_at` isn't given.

## Profit and loss

`get_workspace_pnl({ workspace_id, granularity?: "month" | "week", periods?: 1..24, app_id? })` sets what a workspace's apps bring in against what building and running them costs, in US cents. It is for members only, for that workspace's apps only, and is readable while the workspace is frozen or archiving.

Periods are UTC calendar months (the default) or Monday-to-Sunday weeks. `periods` (default 6) counts back from the current one, which is still running.

### What it returns

The reply has four parts:

- `currency`: `"USD"`;
- `series`: `[{ start, end, revenue_cents, costs_cents, net_cents }]`;
- `statement`: `{ columns, revenue, costs, totals: { revenue, costs, net } }`;
- `unmeasured`: `[{ key, label, reason }]`.

How to read them:

- `series` is oldest first.
- `columns` are `this_period`, `last_period` and `year_to_date` (1 January UTC to the end of this period), each `{ key, label, start, end }` with `end` exclusive.
- Every line is `{ key, label, app_id?, product_id?, values: { this_period, last_period, year_to_date }, measured, source }`.

### Revenue

There is one revenue line per app and product: the money Mynt saw settle through the app, at the settled amount, dated when it settled.

- It is the same record and rule as the dashboard's money moved, so the two agree.
- Live only. Sandbox money is left out entirely, not shown as a line.
- It is money moved through the app, not what the app keeps from it.

### Costs

Costs are positive numbers.

| Line | What it is |
| --- | --- |
| `build_agents` | Each build's metered cost: the coding agents' model use through the agent proxy plus its sandboxes' machine time while it runs, which is what the build caps count. Dated when the build started, as the monthly caps count it |
| `audits` | 0, because Mynt pays for its independent audits on their own meter |
| `hosting` | Each hosted app's own VM, its run time sampled from the provider and priced at `FREESTYLE_USD_PER_HOUR` when sampled. 0 if Mynt hosts none of the apps. Unmeasured when the hosting provider runs no VM per app, because only a VM per app reports its run time |
| `sandboxes` | What a build's sandboxes cost after it ends (its preview, up until the sandboxes' time limit) and sandboxes reopened on a finished build (`reopen_sandbox`), from the provider's own cost |
| `mynt_fees` | Unmeasured. Take rates are set per product line, but Mynt has no billing, so it never charges or records a fee |

### How machines are recorded

Machine time is recorded by `core/src/usage-meter.ts` in the table `usage_samples`.

- Every `USAGE_SAMPLE_MS` (default 5 minutes), Mynt samples each machine's running total from its provider and records the increase since the last sample, against the app.
- A machine Mynt has just made (a new app VM, a reopened sandbox) counts from zero. One first seen already running is only a baseline: earlier time isn't guessed. A lower reading never subtracts.
- A build's sandboxes get their baseline when the build ends, because while it runs their time is in the build's own cost.
- An app VM is sampled once more before undeploy deletes it, and a reopened sandbox before it is closed.
- A machine the provider deletes on its own (at its time limit) can lose up to one sampling interval from the record, on a provider that forgets a deleted machine's usage.

### When recording started

Each recorded line counts from when Mynt started recording it:

- revenue from the money ledger's start (`money_ledger_started_at`);
- hosting and sandboxes from their meters' first run (`usage_recording_started_at:hosting` and `usage_recording_started_at:sandbox` in settings).

A period or column that began before then is null, never a partial figure, and `unmeasured` gives `Recording started <date>` for that line.

### What is not measured

- What the apps keep (`app_earnings` in `unmeasured`) isn't recorded. Apps don't charge their customers through Mynt, and a product's fees (in its definition) are the provider's, so Mynt has no record of an app's own cut.
- An unmeasured line's values are null, never 0, with its reason in `unmeasured`.
- A total is null unless every line under it is measured, and `net` (revenue minus costs) is null unless both totals are. Until Mynt charges fees, total costs and net stay null.

Sums run in SQL by day over the periods asked for, on indexes on money movements by app and settlement time, on builds by app and start, and on usage samples by app.

## Workspaces are the identity provider's organizations

When Clerk is the sign-in provider (`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` set), each workspace is one Clerk organization.

Clerk decides who is in a workspace's organization. Mynt alone decides platform roles (developer, user and so on) and who owns a workspace. Syncing never grants a platform role, never raises a workspace role, and never removes anyone or anything on inference.

The core is provider-neutral: `OrgDirectory` in `core/src/org-directory.ts` and `WorkspaceSync` in `core/src/workspace-sync.ts`. The Clerk adapter is `core/src/clerk-orgs.ts`. A workspace's organization is `workspaces.external_org_id`, null until backfilled.

### Making a workspace

`create_workspace`, and Studio's Create workspace, work in this order:

1. Write the workspace as being made.
2. Create the organization, with the caller as its creator and the workspace's id in its private metadata (`mynt_workspace_id`).
3. Link the two.

Clerk's own event about the new organization finds that workspace and doesn't make another. If the organization can't be made or linked, neither is kept.

The first workspace someone makes is their default one, and personal workspaces are organizations too. Renaming a workspace renames its organization.

Every personal workspace is a Clerk organization, so check the Clerk plan's organization limits and pricing before turning this on for many people. Calls to Clerk that are rate-limited (429) are waited out and retried, up to 4 times.

### Roles in the organization

- Clerk's `org:admin` is a workspace `admin` and `org:member` a `member`. Clerk has no owner: owners are Mynt's, shown in Clerk as `org:admin`.
- Changing a role, removing someone or leaving in Mynt changes Clerk first. If Clerk refuses, nothing changes in Mynt.
- In the other direction, an admin made a member in Clerk becomes a member in Mynt, with Mynt's demotion offboarding.
- Someone made an admin only in Clerk is put back to `org:member` (`workspace_role_restored`). Workspace roles are raised in Mynt (`change_member_role`).
- An owner removed or demoted in Clerk is put back there (`workspace_owner_restored`). An owner leaves with `leave_workspace`, or another owner removes them.
- Syncing never makes anyone an owner, except that whoever creates a new organization in Clerk owns that new workspace.

### Organization invitations

Workspace invitations are Clerk organization invitations, sent with the same rules for who may invite whom, so Clerk emails the invitee. Their public metadata carries Mynt's invite id (`mynt_invite_id`), the Mynt role (`mynt_role`: `developer` or `user`) and the workspace role. They link back to Studio (`STUDIO_URL`).

- An invite accepted in Mynt (`accept_workspace_invite`) adds the Clerk membership and spends the invitation.
- An invite accepted with Clerk counts only when Clerk's invitation id and Mynt's invite id match each other. Then Mynt's own acceptance rules apply: the invite is still open (30 days), its sender may still invite to that role, the developer role goes only to a user's account, and never past roles a Mynt admin set since.
- An invite that stops standing (withdrawn, declined, lapsed or void) withdraws Clerk's invitation too.

### What the provider changes, Mynt follows

Mynt follows Clerk by a signed webhook and a reconcile worker. Each event is read back from Clerk before it is applied, so a late, repeated or out-of-order delivery can't undo a newer change.

- Someone on Mynt who joins an organization in Clerk, not through a Mynt invite, is a member and nothing more.
- Someone not on Mynt who joins an organization in Clerk isn't let onto Mynt. It is a join request that the workspace's owners and admins see in `list_workspace_members` (`join_requests`). An invite from Mynt lets them in. Until then they are kept an `org:member` in Clerk.
- So Clerk's `org:admin`s are only ever Mynt's owners and admins, and any removal or role change made in Clerk is one a Mynt owner or admin could have made (an owner's is undone anyway).
- Clerk's webhooks don't say who made a change, so the audit records the event id and the request's address and client (`via`, `event`).
- A new organization made in Clerk (Clerk's "create your first organization" step at sign-in) becomes its creator's workspace, if they are on Mynt. Their platform roles don't change.
- Someone a Mynt admin revoked is removed from the organization again (`workspace_member_refused`). That covers their Mynt address and every address Clerk verified as theirs.
- A membership Clerk confirms is gone runs Mynt's offboarding. This applies only to someone Mynt has seen in the organization. A member who is in Mynt only so far (from before organizations, or not yet signed in through Clerk) is added to the organization instead, never taken out.
- An organization Clerk confirms deleted (404) freezes its workspace. Nobody is removed and nobody new joins. `list_workspaces` and `ops_status` say so. An owner either relinks it (`relink_workspace_org`: a new organization with its members) or archives it.

Writes to Clerk made by syncing happen only after Mynt's transaction commits, so a rate-limit wait never holds a workspace's row.

### Archiving a workspace

`archive_workspace` (owners only) freezes the workspace.

- It is refused while any of the workspace's apps is published or hosted: unpublish and undeploy them first.
- 7 days later, everyone is removed and offboarded, in one transaction with the archive's end, and its organization is deleted.
- Until then, any owner can undo it with `unarchive_workspace`.
- If an app has gone live meanwhile, the archive waits a day at a time and the audit says so.
- With `now: true` it happens at once, but only for a workspace's sole owner.

### The organization webhook

The webhook is `POST /webhooks/clerk`.

- It takes `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted` and `organizationInvitation.accepted`.
- It is verified with Clerk's own library (`verifyWebhook`), which also refuses an old or replayed signature.
- Each event id is handled once; ids are kept 30 days. An event that fails isn't recorded, so Clerk delivers it again.
- It is off (404) while `CLERK_WEBHOOK_SECRET` isn't set.

### The reconcile worker

The reconcile worker runs every 15 minutes, backing off up to 2 hours while Clerk fails. Each person's own memberships are also reconciled when they sign in, at most every 5 minutes.

- It reads everything before changing anything, and confirms each removal and each missing organization with Clerk one by one.
- Its circuit breaker stops it and changes nothing when Clerk lists no organizations while workspaces are linked, or when more than a tenth of the linked organizations, or of the members Mynt has seen in them, would go in one run. `ops_status` then says why. One at a time always proceeds.
- It leaves alone workspaces still being made or backfilled.
- A workspace whose making crashed more than an hour ago, with no apps, is cleared away.
- An organization this installation made for a workspace that doesn't exist (tagged with its id and this installation's `mynt_instance`) is deleted once it is an hour old. Another installation's organizations are never touched.

### Workspaces from before organizations

Workspaces from before organizations get theirs with `mynt clerk sync-workspaces`. It is a dry run unless `--apply` is given, and it prints counts only.

- The organization is made for the workspace's owner, and its members are added (owners and admins as `org:admin`).
- Each workspace stays marked as being backfilled until all its members are in. A run that failed part-way is resumed by running it again, and the reconcile worker leaves it alone meanwhile.
- Members who never signed in through Clerk stay in Mynt and are added to the organization at their first sign-in.
- Open invites become Clerk invitations, which email the invitees, only with `--send-invites`. The dry run reports how many emails that would send (`invitation_emails_would_send`). Without it, those invites still work in Mynt.

Studio's Settings page, with its Members tab, keeps working. `list_workspace_members` gives `manage_url`, the organization's own page in Clerk's account portal.

### Turning organizations on

These are the operator's steps. Clerk's Organizations setting stays on with "membership required": its "create your first organization" step becomes "create your first workspace".

1. In the Clerk dashboard, open **Webhooks**, choose **Add Endpoint**, and give it `<Mynt's public URL>/webhooks/clerk`.
2. Subscribe it to `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted` and `organizationInvitation.accepted`, then create it.
3. Copy the endpoint's **Signing Secret** and set it yourself on the server as `CLERK_WEBHOOK_SECRET`, then restart Mynt. Never paste it into a chat or a command.
4. Optionally, set `STUDIO_URL` to Studio's address so that invitations link back to it.
5. On the server, run `node dist/index.js clerk sync-workspaces` and read the counts. Nothing changes.
6. Run `node dist/index.js clerk sync-workspaces --apply`. If `failed` isn't 0, run it again: it resumes.
7. Only if you want the open invites emailed by Clerk, run `node dist/index.js clerk sync-workspaces --apply --send-invites`. The dry run's `invitation_emails_would_send` says how many. That emails people, so decide it explicitly.

## Invite-only sign-in

A Mynt server that uses an identity provider lets in only people who were invited. Being able to sign in with the provider is not enough.

### Who may sign in

- Each request's access token is verified, and the caller's verified email must be on Mynt's list of invited people.
- The entry on that list also decides the caller's roles.
- Removing it cuts the person off on their next request. What they created stays.

There are three ways onto the list.

| Way | Who does it | Roles it gives |
| --- | --- | --- |
| An admin's invitation | A Mynt admin, with `invite_user` | Any of the seven roles, one or several |
| A workspace invitation | A workspace member, with `invite_to_workspace` | `consumer`; `developer` on accepting a developer invite (see [Getting onto Mynt through a workspace invite](#getting-onto-mynt-through-a-workspace-invite)) |
| Public sign-up, when open | The person themselves | `consumer` |

### Admin invitations

| Tool | Does |
| --- | --- |
| `invite_user` | Allows an email to sign in with the given roles, or changes the roles of someone already invited |
| `revoke_user` | Stops an email from using Mynt |
| `list_whitelist` | Lists who may sign in and with which roles, the users who have signed in, and whether public sign-up is on |

- The list is kept in step with the identity provider's allowlist, so people who aren't invited can't sign up at all.
- Mynt refuses any change that would remove the last admin.
- An invitation made in the identity provider's own dashboard can carry roles too, in the user's public metadata as `mynt_roles`. Any of the seven roles is accepted there. On the person's first request Mynt adds them to its list with those roles and logs `invite_via_clerk`.

The operator's steps, the command line and the settings are in [Sign-in with Clerk](operations.md#sign-in-with-clerk).

### Public sign-up

A Mynt admin can open sign-up with `set_public_signup` (`enabled: true`).

- Anyone who signs in with a verified email then joins as a `consumer`. Mynt writes a consumer invite for them, so they show in `list_whitelist` and can be revoked like anyone else.
- Higher roles still come only from `invite_user`.
- `revoke_user` also blocks the email from signing up again, until an admin invites it once more.
- Turning it on turns the identity provider's allowlist off, and turning it off turns the allowlist back on. Both are best effort; Mynt's invites decide access either way.
- Closing sign-up stops new people joining. People already in keep their invites.
- The operator's `clerk setup` command follows the setting.

## Linked accounts

`get_linked_accounts` shows the GitHub account and crypto wallets linked to the caller's sign-in, as the identity provider knows them. It is for anyone signed in through the identity provider.

```json
{
  "git": { "provider": "github", "username": "…", "verified": true },
  "wallets": [{ "chain": "solana", "address": "…", "verified": true }],
  "manage_url": "…"
}
```

`git` is null when no GitHub account is linked. A wallet's `chain` is `solana` or `ethereum`.

- **Where to manage them.** `manage_url` is where they link or unlink accounts: Clerk's Account Portal user page (`https://accounts.<domain>/user` for a production instance, `https://<slug>.accounts.dev/user` for a development one). `CLERK_ACCOUNT_PORTAL_URL` overrides it for a custom domain, and must be a valid https URL or Mynt won't start.
- **Read-only, verified links only.** It returns the verified GitHub account when there are several; an unverified one proves nothing about who holds it. It never returns a token: only the account name and the wallet address.
- **Chains.** A wallet's chain is told from its address: `0x` and 40 hex digits is Ethereum; base58 of 32 to 44 characters is Solana. Any other address isn't shown.
- **Caching.** The answer is cached for a minute per person, and a failure for 15 seconds.
- **Failures.** If the identity provider can't be reached, `git` and `wallets` are null and `unavailable` says so, never with the provider's own error text. If it no longer has the person's account (deleted), `unavailable` says that.

The core is provider-neutral (`IdentityProvider` in `core/src/linked-accounts.ts`). The Clerk adapter is `ClerkIdentityProvider` in `core/src/auth.ts`, which maps a Mynt user to their Clerk id and reads that user's `external_accounts` and `web3_wallets`.

## Chat sessions

Mynt Studio keeps each signed-in user's chats on Mynt, not in the browser: the financial-product chats on the Build page and the Earn chats. They share one shape (`core/src/chat-sessions.ts`), so an app's build conversation can use it later.

### Sessions and events

A chat is a session with an append-only log of events.

| Table | Columns |
| --- | --- |
| `financial_products.chat_sessions` | `id`, `user_id`, `workspace_id` or null, `kind` (`product`, `earn` or `app`), `title`, `metadata` (small references only, such as a product id), `last_seq`, `created_at`, `updated_at` |
| `financial_products.chat_events` | `session_id`, `seq`, `type`, `role`, `client_id`, `payload`, `created_at` |

Events are numbered 1, 2, 3 and so on with no gaps, like a coding agent's session file.

| Event type | Holds |
| --- | --- |
| `message` | One UI message as Studio has it, with its id, role and parts, data parts included |
| `outcome` | What became of a draft: its idempotency key, sent or declined, the product it became |
| `title` | `{ title }`, which retitles the session |
| `metadata` | Values merged into the session's metadata |
| `part`, `draft` | Kind-specific state |

Events are never changed or removed one by one. A message that changed is appended again under its id, and the later copy wins when the log is replayed. Reading a session is replaying its events in order.

### Chat session tools

These are for anyone signed in, on their own chats only.

| Tool | Does |
| --- | --- |
| `create_chat_session` | Creates a session under an id the caller picks. Creating it again answers the same session |
| `append_chat_events` | Appends up to 100 events per call, in order. An event whose `client_id` the session already has is skipped, so a retried append never adds anything twice. `expect_seq` refuses the append unless the log still ends there |
| `list_chat_sessions` | Lists sessions newest first, by `kind`, without events. `query` keeps those whose title or messages hold every word of it, each with a `snippet` |
| `get_chat_session` | Returns the events in order, only those after `after_seq` when given. `format: "jsonl"` returns the session as JSONL: its own line, then one line per event |
| `delete_chat_session` | Deletes the session and every event in it |

### Who can read a chat

- Only the user who had a chat reads, adds to or deletes it. Their workspace and Mynt admins don't.
- Another user's session id is refused in the same words as a missing one.
- A `workspace_id` must be a workspace the user is a member of.

### Chat limits

- 128 KB per event.
- 1 MB and 5,000 events per session. Past that, Studio says to start a new conversation.
- 200 sessions per user of each kind. A new one past that deletes their oldest of that kind, with its events.

### What is logged

What was said is stored as given and never logged. The audit log records `create_chat_session`, `append_chat_events` and `delete_chat_session` with counts and event types only, never a message's text or a title.

Studio's `/api/threads` routes call these tools as the signed-in user. On first load Studio uploads any chats an older version kept in that browser's storage (idempotent by session id and event `client_id`), then clears them there.
