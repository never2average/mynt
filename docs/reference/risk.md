# Risk

This file covers the risk registers kept for apps, for financial products and for Mynt itself, the seven risk areas they are grouped by, and Mynt's own risk models. It is for builders, who keep the registers of their apps and products, and for Mynt admins, who keep the platform's register and its risk models.

See also: [Agreements](agreements.md), [Products](products.md), [Workspaces and sign-in](workspaces-and-sign-in.md), [Platform administration](platform-admin.md), [Mynt Studio](studio.md).

## Risk registers

Apps and financial products each keep a risk register of the same shape, and so does Mynt itself (the platform's own register). A register says what could go wrong, how likely it is and how bad it would be, who owns it, what is being done about it and when it is next looked at.

### What a risk holds

| Field | What it holds |
| --- | --- |
| `title`, `description` | The risk in words |
| `category` | One of the nine risk categories: `security`, `fraud`, `vendor`, `conduct`, `operational`, `compliance`, `credit`, `liquidity` or `other` |
| `risk_area` | One of the seven [risk areas](#risk-areas). Required on Mynt's own register. Elsewhere it is its category's by default. Null is unassigned |
| `likelihood`, `impact` | 1 to 5 each |
| `score`, `level` | The `score` is likelihood times impact. Its `level` is `low` (1-4), `medium` (5-9), `high` (10-14) or `critical` (15-25) |
| `owner` | A member of the app's workspace, or of the product's firm. By default, whoever adds the risk |
| `mitigation` | What is being done about it |
| `status` | `open`, `mitigating`, `accepted` or `closed` |
| `review_by` | The date it is next reviewed by. Past it, and not closed, the risk is `overdue` |

### Who keeps which register

A register's subject (`subject_type`) is `app`, `product` or `platform`.

| Register | Adds and reviews risks | Reads it |
| --- | --- | --- |
| An app's | Its workspace's owners and admins | Any member of its workspace |
| A financial product's | Its own firm: the product's owner, or a builder at the firm it belongs to | Its firm, and the licence providers sponsoring it (an approved sponsorship), read-only |
| Mynt's own (`subject_type: "platform"`, `subject_id: "mynt"`) | Mynt admins | Mynt admins only. To anyone else it doesn't exist |

### Register tools

**`add_risk({ subject_type: "app" | "product" | "platform", subject_id, title, category, risk_area?, likelihood, impact, description?, mitigation?, owner_user_id?, review_by? })`** adds a risk, `open`. `risk_area` is required for `platform`.

**`update_risk({ risk_id, status?, risk_area?, mitigation?, likelihood?, impact?, owner_user_id?, review_by?, note? })`** reviews a risk. Only what is passed changes. Accepting or closing a risk needs a `note` saying why.

**`list_risks({ subject_type, subject_id, status?, category?, risk_area?, overdue_only?, risk_id? })`** lists the register, newest first, with:

- counts by status and of overdue reviews;
- `can_manage`: whether the caller may add and review.

`risk_area` is one area, or `unassigned` for risks with none. With `risk_id`, the reply is that risk and its history: every change with what it was and what it became, who made it and the note, read from the audit trail.

**`admin_list_risks({ limit?, subject_type?, risk_area? })`**, for Mynt admins, reads every register's risks that aren't closed: apps', products' and the platform's, or one kind, or one risk area, or `unassigned`. It returns:

- counts by level (`critical`, `high`, `medium`, `low`), how many are overdue, and the total;
- the risks, highest scored first, then by review date;
- for each risk, its `subject_name` and where it lives: `workspace_id` for an app's, `firm_id` for a product's, null for a reference product.

### Signals around an app

For an app, `list_risks` also returns `signals`, what Mynt measures around it. Each is `{ available: true, rows }`, or `{ available: false, reason }` when Mynt doesn't measure it. It is never an empty list in its place.

| Signal | Rows |
| --- | --- |
| `fraud` | Not measured yet. Mynt records no fraud or velocity signals from customer sessions |
| `vendors` | The workspace's vendor services whose latest conformance run failed, whose calls mostly erred over the last 7 days, or whose subscription ended in the last 90 days; and the app's vendor contracts that were ended or ran out |
| `conduct` | Findings still open in the oversight audits licence providers run under the app's agreements, for requirements of the `marketing_review` and `complaints_review` kinds (see [Oversight audits](agreements.md#oversight-audits)) |
| `products` | The app's products with new sales paused by a licence provider's covenant, or drifted from their published composition |

### Audit and operations

- Every change is audited with the app's or product's id (`add_risk`, `update_risk`, in the obligations class), so it shows in the app's audit trail.
- `ops_status` counts risks whose review date has passed and that aren't closed (`risks.overdue_reviews`), and says so under what needs attention. Overdue reviews of the platform's risks count with the others'.
- `remove_app` removes the app's register with it. Each risk's history stays in the audit trail.

## Risk areas

The platform groups risk into seven risk areas. Every risk on a register may carry one (`risk_area`), and every risk model has one. An area is also the tab a risk or a model shows under in the platform admin.

| `risk_area` | Label |
| --- | --- |
| `financial` | Financial risk |
| `compliance` | Compliance risk |
| `third_party` | Third-party risk |
| `operations` | Operations risk |
| `business_process` | Business process risk |
| `technology` | Technology risk |
| `regulated_product` | Regulated product risk |

### How categories map to areas

A risk's `category` stays as it was given. Its `risk_area` is the platform's coarser grouping.

When no area is given, the risk takes its category's. Risks made before risk areas existed were filled in the same way, once, when the server starts.

| `category` | `risk_area` |
| --- | --- |
| `credit`, `liquidity` | `financial` |
| `compliance`, `conduct` | `compliance` |
| `vendor` | `third_party` |
| `operational`, `fraud` | `operations` |
| `security` | `technology` |
| `other` | None: unassigned until a review gives it one |

No category maps to `business_process` or `regulated_product`. A risk is in one of those areas only when the area is given.

## Risk models

Mynt keeps its own risk models: how the platform measures each of its seven risk areas. They are kept and read by Mynt admins only. To anyone else the tools don't exist.

A financial product's own risk models stay in its definition (`risk_models`; see [Product definitions](products.md#product-definitions)).

### What a risk model holds

| Field | What it holds |
| --- | --- |
| `risk_area` | One of the seven: `financial`, `compliance`, `third_party`, `operations`, `business_process`, `technology`, `regulated_product` |
| `name`, `purpose` | What it is and what it is for |
| `method` | The formula or approach, in words |
| `inputs` | A list of `{ name, description?, source? }` |
| `outputs` | The scores or measures it produces: a list of `{ name, description? }` |
| `thresholds` | A list of `{ name, value, meaning? }`: the level (a number or words) and what happens at or beyond it |
| `owner` | A Mynt admin. By default, whoever adds it |
| `status` | `draft`, `active` or `retired` |
| `version` | Starts at 1. Each change to what the model is (name, purpose, method, inputs, outputs, thresholds) adds a version and never changes an old one |
| `validation` | The last one (`last_validated_at`, `validated_by`, `outcome`, `notes`), `next_validation_due`, and `overdue` once that date has passed on a model that isn't retired |

A validation's `outcome` is `passed`, `passed_with_findings` or `failed`.

### Risk model tools

**`add_risk_model({ risk_area, name, purpose, method, inputs?, outputs?, thresholds?, owner_user_id?, status?: "draft" | "active", next_validation_due? })`** adds a model at version 1, `draft` by default.

**`update_risk_model({ model_id, name?, purpose?, method?, inputs?, outputs?, thresholds?, owner_user_id?, status?, next_validation_due?, note? })`** changes a model that isn't retired.

- A change to what it is adds a version. The rest is carried over, and `note` is kept as its change note.
- Owner, status and due date change on the model itself.

**`validate_risk_model({ model_id, outcome, notes, next_validation_due })`** records a validation of the current version. Every one is kept. A failed one doesn't change the status.

**`retire_risk_model({ model_id, reason })`** retires a model. It stays listed with its history, can't be changed or validated, and is never overdue.

**`list_risk_models({ risk_area?, status?, model_id? })`** lists the models, newest first, with counts by status and of overdue validations. With `model_id`, the reply is that model, every version (oldest first) and every validation (newest first).

**`admin_list_product_risk_models({ query?, limit? })`** reads the risk models financial products declare in their definitions, across every firm. Each comes with its product (id, name, status) and its firm (none for a reference product). It is read-only.

### Audit and operations for risk models

- Every change is audited, in the obligations class: `add_risk_model`, `update_risk_model`, `validate_risk_model`, `retire_risk_model`.
- `ops_status` counts models past their next validation date (`risk_models.overdue_validations`, null on a server without them) and says so under what needs attention.

## Risk in Studio

Risk shows in four places in Mynt Studio:

| Where | What it shows |
| --- | --- |
| An app's **Security & risk** tab | The app's risk register, among the tab's sections |
| A product's **Risk** tab, in the product workspace at `/products/<id>` | The product's risk register |
| The platform admin's **Risk register** section (`/platform/risk-register`) | Mynt's own register, one risk area per tab. Mynt admins only |
| The platform admin's **Risk models** section (`/platform/risk-models`) | Mynt's risk models, one risk area per tab. Mynt admins only |

A register is a table of risks: title, category, likelihood and impact score, owner, status in words and review-by date. Whoever keeps the register (`can_manage`) has a labelled **Add risk** button and a **Review risk** button on each row, each opening a sheet.

See [The platform admin in Studio](platform-admin.md#the-platform-admin-in-studio) for the two platform sections.
