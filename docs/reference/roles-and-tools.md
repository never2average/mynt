# Roles and tools

This file names Mynt's seven roles, how they nest, what each one does and where its tools are explained. Read it first: every other reference file assumes you know which role you hold.

See also: [the reference index](../reference.md), [Products](products.md), [Apps and builds](apps-and-builds.md), [Workspaces and sign-in](workspaces-and-sign-in.md), [Platform administration](platform-admin.md).

## The seven roles

Mynt's code has seven roles and six kinds of user. `developer` and `innovator` are two names for one role, the builder: each implies the other, so whoever holds either composes and publishes products and builds apps on them.

| Role in code | Called here | What it does | Read |
| --- | --- | --- | --- |
| `consumer` | Consumer | Enrols in financial products, answers offers and asks for products that don't exist yet | [Consumer](#consumer) |
| `developer`, `innovator` | Builder | Composes, tests and publishes financial products, and builds apps on them with coding agents | [Products](products.md), [Apps and builds](apps-and-builds.md), [Runtime API](runtime-api.md) |
| `license_provider` | Licence provider | A firm that holds licences and sponsors builders' products under them | [Firms, licences and licence providers](licence-providers.md) |
| `vendor` | Vendor | A firm that offers standard services builders plug into their products | [Vendors and the marketplace](vendors-and-marketplace.md) |
| `liquidity_provider` | Liquidity provider | A firm or fund that puts capital into products' pools and takes it out | [Liquidity pools and on-chain treasuries](liquidity-and-treasury.md) |
| `admin` | Mynt admin | Runs Mynt itself: regions, the regulatory model, firms, invitations and oversight | [Platform administration](platform-admin.md) |

A builder needn't hold a licence. A licence provider can sponsor a product under its own licences (see [Sponsorship](licence-providers.md#sponsorship)).

## How roles nest

Tools are registered per user, so a client only sees the tools its roles allow. `whoami` shows the roles an account was granted and the effective roles they include.

| Role | Also includes |
| --- | --- |
| `developer` | `innovator` and `consumer` |
| `innovator` | `developer`, and so `consumer` |
| `admin` | `innovator` (the builder, and so `consumer`), `vendor` and `license_provider` |
| `vendor` | nothing |
| `license_provider` | nothing |
| `liquidity_provider` | nothing |
| `consumer` | nothing |

What follows from that:

- Every Mynt admin is also a builder, a vendor and a licence provider, and every builder is a consumer.
- One exception: seven licence-provider tools act as a member of the firm itself, and they go only to that firm's licence providers, never to a Mynt admin. They are `approve_partner_kit_change`, `confirm_partner_ledger_endpoints`, `decide_firm_member`, `register_partner_test_signing_key`, `reveal_partner_ledger_secret`, `rotate_partner_ledger_secret` and `upload_partner_ledger_file` (see [Licence providers](licence-providers.md)).
- A Mynt admin is not a liquidity provider: Mynt's staff don't commit capital.
- Vendors, licence providers and liquidity providers stand beside builders. Each gets the catalogue tools, its firm's record and its own tools only. None of them can publish products or build apps.
- A Mynt admin can grant one person several roles.
- `innovator` and `developer` are both kept so that existing users and invitations keep working. `whoami` shows both among the effective roles.

### Licence-provider powers need standing at the firm

Holding `license_provider` is not enough on its own. An account that belongs to a firm acts as a licence provider only once it has standing there:

- A firm's first licence provider has standing at once.
- After that, a new account waits until one of the firm's licence providers accepts it (`decide_firm_member`).
- Until then the account gets no licence-provider tool, and makes no sponsorship, covenant or licence decision.

See [Partner kit](licence-providers.md#partner-kit) for how members are accepted and recovered.

## Tools everyone gets

Everyone gets the catalogue tools, including guests who connect without a token. They are read-only.

| Tool | Returns |
| --- | --- |
| `whoami` | The current user, the roles granted and what those include. A guest can only browse |
| `list_products` | Published financial products, filtered by product line, category, region, risk level or a free-text query |
| `get_product` | One product in full, by its id. A builder can also fetch its own unpublished products |
| `list_categories` | Product lines, categories, regions and risk levels of published products, with counts |
| `list_product_categories` | The product types products can have, and the product lines each is used in |
| `list_apps` | Published apps that builders have made around financial products |
| `list_regions` | The regions products can be offered in, with their regulators |
| `get_region` | One region's regulators, regulatory ecosystem, legal procedure per product line and official sources |
| `get_regulator` | One regulator: what it supervises and every licence it grants, with that licence's governance, risk and compliance (GRC) data |
| `list_legal_instruments` | A region's law in two branches, legislative and judiciary |
| `find_licenses` | The licences in a region that permit an action on a product category for a customer persona |
| `list_regulated_product_types` | A region's regulated product types and the regulators that supervise each |
| `get_product_regime` | The primitives a product is made of and what each falls under: product types, regulators, licences, law, providers and mandated stakeholders |
| `get_template` | A regulator's template for a record a licensee must keep, with its field schema |
| `list_template_defaults` | The default field schema each template kind starts from |

Everyone can also read the resource `mynt://catalog`, the published product catalogue as JSON.

The regulatory tools are explained in [The regulatory model](platform-admin.md#the-regulatory-model), and `list_products` and `get_product` in [Products](products.md).

## Tools every signed-in account gets

Every account that signs in gets these, whatever its role.

| Group | Tools | Explained in |
| --- | --- | --- |
| Firm notices | `list_firm_notices`, `block_firm_recovery` | [Partner kit](licence-providers.md#partner-kit) |
| Workspace invitations | `list_my_invitations`, `accept_workspace_invite`, `decline_workspace_invite` | [Members and invitations](workspaces-and-sign-in.md#members-and-invitations) |
| Chat sessions | `create_chat_session`, `list_chat_sessions`, `get_chat_session`, `append_chat_events`, `delete_chat_session` | [Chat sessions](workspaces-and-sign-in.md#chat-sessions) |
| Linked accounts | `get_linked_accounts` | [Linked accounts](workspaces-and-sign-in.md#linked-accounts) |

`get_linked_accounts` is registered only on a server that has an identity provider set up.

Two more groups go to signed-in accounts, with one exception. An account that holds only firm roles (`vendor`, `license_provider` or `liquidity_provider`, without `consumer`) does not get them.

| Group | Tools | Explained in |
| --- | --- | --- |
| Product requests | `request_product`, `list_my_product_requests` | [Product requests](products.md#product-requests) |
| The connector | `connect_with_mynt`, `connect_my_intros`, `connect_answer_intro`, `connect_refer`, `connect_forget_me` | [The connector](platform-admin.md#the-connector) |

The `connect_*` tools exist only on a server that runs the connector (`BD_ENABLED`).

## Who does what

### Consumer

A consumer uses financial products: enrols, answers offers and asks for products that don't exist yet.

- Enrolment: `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment`, `upgrade_enrollment`
- Offers from campaigns: `list_offers` (see [Campaigns](apps-and-builds.md#campaigns))
- Product requests: `request_product`, `list_my_product_requests` (see [Product requests](products.md#product-requests))

### Builder

A builder (`innovator` or `developer`) does two jobs with one role.

It composes financial products. A builder acts for a firm (`create_entity`) and registers the licences the firm holds (`register_license`), which a Mynt admin verifies against the regulator's register (`review_license`). A product declares the firm's role on it in `action`: `issuance`, `sale` or `repackaging`, with `underlying_product_ids` for the last two.

Publishing a product needs a verified, in-date licence covering each of its components. The licence is either the firm's own or a licence provider's, under an approved sponsorship of that component.

It also builds apps and software development kits (SDKs) on products. An app never issues a product, holds funds or collects financial data itself. Onboarding, identity checks and payments hand off to the product's own flow (`deep_link`, `initiate_onboarding`; see [Hand-offs](runtime-api.md#hand-offs)).

Products:

- Compose and publish: `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products` (see [Products](products.md))
- Definitions: `set_product_definition`, `get_product_definition`, `check_product_definition`, `set_product_composition` (see [Product definitions](products.md#product-definitions))
- Stages: `get_product_promotion_checks`, `promote_product`, `demote_product` (see [Product stages](products.md#product-stages))
- Out of the way: `archive_product`, `unarchive_product` (see [Archiving a product](products.md#archiving-a-product))
- Versions: `create_product_version`, `update_product_version`, `list_product_versions`, `diff_product_versions`, `restore_product_version`, `list_product_activity`, `upgrade_enrollments` (see [Versioning](products.md#versioning))
- Distribution and earnings: `get_product_distribution_metrics`, `report_handoff_outcome`, `get_product_take_rate` (see [Hand-offs](runtime-api.md#hand-offs) and [Take rates](platform-admin.md#take-rates))
- Product requests: `list_product_requests`, where requesters appear only under a pseudonymous id, and `respond_to_product_request`, which offers one of your published products and is audited (see [Product requests](products.md#product-requests))
- Product ideas and the product desk: see [Product ideas](products.md#product-ideas) and [The product desk](products.md#the-product-desk)
- Sponsorship: `request_sponsorship`, `list_my_sponsorships` (see [Sponsorship](licence-providers.md#sponsorship))
- The firm: `create_entity`, `get_my_entity`, `register_license`, `set_entity_facts`, `add_party`, `end_party` (see [Legal entities](licence-providers.md#legal-entities))

Apps:

- Apps: `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app` (see [Apps](apps-and-builds.md#apps))
- Access to products: see [Building on a product](apps-and-builds.md#building-on-a-product)
- Builds, repositories and hosting: see [Coding-agent builds](apps-and-builds.md#coding-agent-builds), [Repositories](apps-and-builds.md#repositories) and [Hosting](apps-and-builds.md#hosting). For an app in Production, `deploy_app`, `undeploy_app`, `restart_app` and `app_run` are for its workspace's owners and admins only (see [Who puts a build online](apps-and-builds.md#who-puts-a-build-online))
- Campaigns: `create_segment`, `list_my_segments`, `create_campaign`, `update_campaign`, `lint_campaign`, `launch_campaign`, `pause_campaign`, `end_campaign`, `list_my_campaigns`, `get_campaign_metrics` (see [Campaigns](apps-and-builds.md#campaigns))
- Keys: `create_api_key`, `list_api_keys`, `rotate_api_key`, `revoke_api_key` (see [Keys](runtime-api.md#keys))
- Webhooks: `create_webhook`, `list_webhooks`, `delete_webhook`, `rotate_webhook_secret`, `list_webhook_deliveries` (see [Webhooks](runtime-api.md#webhooks))
- Sandbox mode and releases: `create_test_consumer`, `simulate_handoff`, `release_app`, `list_app_releases`, `rollback_app`, `get_app_metrics` (see [Sandbox and releases](runtime-api.md#sandbox-and-releases))
- SDKs, journeys and modules: see [SDKs and experiences](runtime-api.md#sdks-and-experiences), [Journeys](runtime-api.md#journeys) and [Developer modules](runtime-api.md#developer-modules)
- Solana programs: see [Solana programs](solana-programs.md)

Workspaces, agreements and risk:

- Workspaces: `list_workspaces`, `create_workspace`, `rename_workspace`, `list_workspace_members`, `invite_to_workspace`, `revoke_workspace_invite`, `change_member_role`, `remove_workspace_member`, `leave_workspace`, `relink_workspace_org`, `archive_workspace`, `unarchive_workspace` (see [Workspaces](workspaces-and-sign-in.md#workspaces))
- App stages: `get_promotion_checks`, `promote_app`, `demote_app`, `set_app_target_states`, `request_promotion_signoff`, `get_workspace_attention` (see [Stages and promotion](workspaces-and-sign-in.md#stages-and-promotion))
- Production code reviews: `request_production_review`, `get_production_review`, `list_production_reviews`, `stop_production_review` (see [The production code review](apps-and-builds.md#the-production-code-review))
- Agreements: `propose_app_agreement`, `update_agreement_scopes`, `respond_to_app_agreement`, `sign_app_agreement`, `terminate_app_agreement`, `list_app_agreements`, `get_agreement_signing_link`, `download_agreement_document` (see [App agreements](agreements.md#app-agreements))
- Customers: `get_app_customers`, `set_app_target_segments` (see [Target customers](agreements.md#target-customers))
- Oversight audits: `list_agreement_audits`, `get_agreement_audit`, `submit_agreement_audit_evidence`, `respond_to_agreement_audit_finding` (see [Oversight audits](agreements.md#oversight-audits))
- Service levels: `list_agreement_slas`, `add_agreement_sla`, `retire_agreement_sla`, `record_sla_breach`, `resolve_sla_breach` (see [Service levels](agreements.md#service-levels))
- Risk registers, for apps and products: `add_risk`, `update_risk`, `list_risks` (see [Risk registers](risk.md#risk-registers))
- One risk in full, and what its keeper adds under it: `get_risk`, `add_risk_factor`, `update_risk_factor`, `remove_risk_factor`, `add_risk_treatment`, `update_risk_treatment`, `add_risk_control`, `update_risk_control`, `retire_risk_control`, `link_risk`, `unlink_risk` (see [One risk in full](risk.md#one-risk-in-full))

Vendor services and pools:

- Vendor services: `list_service_types`, `list_vendor_offerings`, `subscribe_vendor_service`, `list_my_vendor_subscriptions`, `set_subscription_live`, `unsubscribe_vendor_service` (see [Subscriptions](vendors-and-marketplace.md#subscriptions))
- Services (a builder reads a service of its workspace; creating one takes the vendor role): `get_service`, `list_my_services`, `get_service_type_contract`, `request_service_type`, `list_service_type_requests` (see [Services](services.md))
- Results from vendor services: `create_firm_webhook`, `list_firm_webhooks`, `delete_firm_webhook` (see [Firm webhooks](vendors-and-marketplace.md#firm-webhooks))
- Liquidity pools on its products: see [Liquidity pools](liquidity-and-treasury.md#liquidity-pools)

### Licence provider

A licence provider (`license_provider`) is a firm that holds licences, verified by Mynt admins, and sponsors builders' products under them. It approves, declines or revokes sponsorship of a product's component under a licence it holds, in the jurisdictions that licence covers. Its firm is added by hand by a Mynt admin.

- Sponsorship: `list_my_licenses`, `list_sponsorship_requests`, `approve_sponsorship`, `decline_sponsorship`, `revoke_sponsorship`, `list_sponsored_products` (see [Sponsorship](licence-providers.md#sponsorship))
- Onboarding: `get_regulated_firm_onboarding` (see [Onboarding a regulated firm](licence-providers.md#onboarding-a-regulated-firm))
- The firm: `get_my_entity`, `register_license`, `set_entity_facts`, `add_party`, `end_party`. Its roster fills the stakeholders its licences mandate (see [Legal entities](licence-providers.md#legal-entities))
- Agreements apps propose to its firm: `list_app_agreements`, `respond_to_app_agreement`, `sign_app_agreement`, `terminate_app_agreement`, `get_agreement_signing_link`, `download_agreement_document` (see [App agreements](agreements.md#app-agreements))
- Agreements it proposes to workspaces: `propose_workspace_agreement`, and `update_agreement_scopes` while one is proposed (see [Scopes](agreements.md#scopes))
- Program agreement templates: `upload_agreement_template`, `list_agreement_templates`, `retire_agreement_template` (see [E-signature](agreements.md#e-signature))
- Oversight audits it runs: `add_agreement_audit_requirement`, `retire_agreement_audit_requirement`, `open_agreement_audit`, `record_agreement_audit_finding`, `resolve_agreement_audit_finding`, `close_agreement_audit`, `list_agreement_audits`, `get_agreement_audit` (see [Oversight audits](agreements.md#oversight-audits))
- Service levels: `add_agreement_sla`, `retire_agreement_sla`, `record_sla_breach`, `resolve_sla_breach`, `list_agreement_slas` (see [Service levels](agreements.md#service-levels))
- Risk registers of the products it sponsors: `list_risks` and `get_risk`, read-only (see [Risk registers](risk.md#risk-registers))
- Covenants: `set_covenant`, `list_covenants`, `delete_covenant`, `list_covenant_breaches`, `acknowledge_breach`, `release_covenant_pause` (see [Covenants](licence-providers.md#covenants))
- Alerts to its firm: `create_firm_webhook`, `list_firm_webhooks`, `delete_firm_webhook` (see [Firm webhooks](vendors-and-marketplace.md#firm-webhooks))
- Its ledger and product health: see [Partner kit](licence-providers.md#partner-kit) and [Product health](licence-providers.md#product-health)
- Money rails and pools on sponsored products: see [Money rails](money-rails.md) and [Liquidity pools](liquidity-and-treasury.md#liquidity-pools)

### Vendor

A vendor offers standard services that builders plug into their products instead of each integrating them: identity checks, business verification, bank account verification, bureau reports, smart-contract audits and the Mynt Ramp. A vendor is a peer of builders, neither above nor below them. Mynt Studio calls vendors "service providers".

- Offerings: `list_service_types`, `create_vendor_offering`, `update_vendor_offering`, `run_practice_conformance`, `run_conformance`, `list_my_offerings` (see [Offerings and conformance](vendors-and-marketplace.md#offerings-and-conformance))
- Onboarding: `get_vendor_onboarding` (see [Onboarding a vendor](vendors-and-marketplace.md#onboarding-a-vendor))
- Services built on Mynt, the third kind beside apps and financial products: `create_service`, `archive_service`, and with builders `get_service`, `list_my_services`, `get_service_type_contract`, `request_service_type`, `list_service_type_requests` (see [Services](services.md)). Building one also takes the builder's tools (`start_build`, `deploy_app`, `promote_app`)
- Subscribers: `list_my_subscribers`, `reveal_subscription_secret`, `rotate_subscription_secret` (see [Subscriptions](vendors-and-marketplace.md#subscriptions))
- The Mynt Ramp, for the firm that runs it: `set_ramp_adapter`, `link_ramp_partner_customer` (see [The Mynt Ramp](vendors-and-marketplace.md#the-mynt-ramp))
- The firm: `get_my_entity`, `register_license`
- Agreements with apps: see [App agreements](agreements.md#app-agreements). A vendor has no agreement templates: its terms are its offerings' standard terms

### Liquidity provider

A liquidity provider (`liquidity_provider`) is a firm or fund, added by a Mynt admin, that puts capital into products' pools and takes it out. It watches each product's health to decide where capital goes. It gets its own tools and none of a builder's or a consumer's.

See [Liquidity pools](liquidity-and-treasury.md#liquidity-pools), [The withdrawal queue](liquidity-and-treasury.md#the-withdrawal-queue) and [Product health](licence-providers.md#product-health).

### Mynt admin

A Mynt admin (`admin`) runs Mynt itself, from inside Mynt: regions, product types, the regulatory model, who may sign in, firms and oversight. Admin tools sit beside the builder, vendor and licence-provider tools an admin also holds, except the seven licence-provider tools named in [How roles nest](#how-roles-nest).

- Regions and product types: `define_region`, `define_product_category`, `recompute_product_derived` (see [The regulatory model](platform-admin.md#the-regulatory-model))
- Who may sign in: `list_whitelist`, `invite_user`, `revoke_user` (see [Invite-only sign-in](workspaces-and-sign-in.md#invite-only-sign-in))
- Firms: `register_firm`, `add_entity_member`, `remove_entity_member`, `recover_firm_member`, `run_firm_checks`, `get_regulated_firm_onboarding` (see [Firms and licence review](platform-admin.md#firms-and-licence-review))
- Oversight: `audit_log`, where each entry carries its `class`, `list_all_campaigns`, `admin_pause_campaign`, `admin_set_product_status` (see [Oversight](platform-admin.md#oversight))
- Production code reviews, across workspaces: `list_production_reviews`, `get_production_review`, `request_production_review`, `stop_production_review`, and the exception for one build, `waive_production_review` (see [The production code review](apps-and-builds.md#the-production-code-review))
- Take rates: `define_take_rate`, `list_take_rates` (see [Take rates](platform-admin.md#take-rates))
- Any workspace's members, by its owners' rules: `admin_invite_workspace_member`, `admin_change_workspace_member_role`, `admin_remove_workspace_member`, `admin_revoke_workspace_invite` (see [Members and invitations](workspaces-and-sign-in.md#members-and-invitations))
- Risk registers: `admin_list_risks`, and Mynt's own with `add_risk`, `update_risk` and `list_risks` on the `platform` subject, and the tools under one risk (`get_risk` reads any register's risk for an admin) (see [Risk](risk.md))
- Risk grading: `get_risk_grading`, `set_risk_grading` (see [Risk grading](risk.md#risk-grading))
- App ideas for the Build page: `create_app_idea`, `update_app_idea`, `retire_app_idea`, `seed_app_ideas` (see [Coding-agent builds](apps-and-builds.md#coding-agent-builds))
- Product ideas: `create_product_idea`, `update_product_idea`, `retire_product_idea`, `seed_product_ideas` (see [Product ideas](products.md#product-ideas))
- Vendors: `define_service_type`, `load_service_types`, `suspend_vendor_offering`, `set_mynt_ramp`, `set_ramp_adapter`, `link_ramp_partner_customer` (see [Vendors and the marketplace](vendors-and-marketplace.md))
- Requested service types: `list_service_type_requests`, `decline_service_type_request`, and `define_service_type` with `from_request` (see [Asking for a service type](services.md#asking-for-a-service-type))

The rest of an admin's work is in [Platform administration](platform-admin.md).

## Where every tool is listed

This file groups tools by role and links to where each group is explained. It is not the full list.

- The generated tool reference on the docs site, at `/docs/tools` in Mynt Studio, lists every tool with its roles and inputs. It is generated from the server's own tool registry.
- `/llms-full.txt` on a Mynt server gives the same list as plain text for AI assistants, with the runtime API and the vendor contract. `/llms.txt` is the short guide.
- `whoami` tells a connected client which roles it holds, and the client's own tool list shows exactly what those roles allow.
