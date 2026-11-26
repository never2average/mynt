# Risk

This file covers the risk registers kept for apps, for financial products and for Mynt itself, how each risk is scored in three steps and graded, what a risk holds under it (factors, treatment tasks, controls and links), the seven risk areas, and Mynt's own risk models. It is for builders, who keep the registers of their apps and products, and for Mynt admins, who keep the platform's register and its risk models.

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
| `inherent` | The inherent score: likelihood times impact, with its `level` and `level_name`. `score` and `level` at the top of the risk are the same two |
| `control` | How well the risk's controls work: `effectiveness` (`none`, `weak`, `partial`, `strong`, or null: not assessed), `words` and a `note` |
| `residual` | The residual score with its `level` and `level_name`, whether it is `assessed`, whether it is `overridden`, and `words` saying which. See [Scoring in three steps](#scoring-in-three-steps) |
| `owner` | A member of the app's workspace, or of the product's firm. By default, whoever adds the risk |
| `mitigation` | What is being done about it |
| `status` | `open`, `mitigating`, `accepted` or `closed` |
| `review_by` | The date it is next reviewed by. Past it, and not closed, the risk is `overdue` |

### Scoring in three steps

Every risk on every register is scored the same way.

1. **Inherent.** Likelihood times impact, 1 to 25: the risk before anything is done about it. Its level comes from the inherent bands.
2. **Control.** How well the risk's controls work together, in four steps: `none`, `weak`, `partial` or `strong`. Until someone says, the control is not assessed.
3. **Residual.** What is left after the controls. Mynt derives it from the inherent score and the control step by the platform's [risk grading](#risk-grading), and grades it by the residual bands.

Two cases are said in words, never as a blank or a 0:

- **Not assessed.** A risk whose control isn't assessed has no derived residual. Its residual is its inherent score, `residual.assessed` is false, and the words say "same as inherent, control not assessed". Risks made before three-step scoring are in this state until they are reviewed.
- **Overridden.** A keeper may set the residual likelihood and impact themselves (`update_risk` with `residual_likelihood`, `residual_impact` and `residual_override_reason`). Their product is the residual score. Who set it, when and why are kept, and a change to the grading never derives it again. `clear_residual_override: true` goes back to the derived score.

### Who keeps which register

A register's subject (`subject_type`) is `app`, `product` or `platform`.

| Register | Adds and reviews risks | Reads it |
| --- | --- | --- |
| An app's | Its workspace's owners and admins | Any member of its workspace |
| A financial product's | Its own firm: the product's owner, or a builder at the firm it belongs to | Its firm, and the licence providers sponsoring it (an approved sponsorship), read-only |
| Mynt's own (`subject_type: "platform"`, `subject_id: "mynt"`) | Mynt admins | Mynt admins only. To anyone else it doesn't exist |

### Register tools

**`add_risk({ subject_type: "app" | "product" | "platform", subject_id, title, category, risk_area?, likelihood, impact, description?, mitigation?, owner_user_id?, review_by?, control_effectiveness?, control_note? })`** adds a risk, `open`. `risk_area` is required for `platform`. Without `control_effectiveness` the control is not assessed.

**`update_risk({ risk_id, status?, risk_area?, mitigation?, likelihood?, impact?, owner_user_id?, review_by?, control_effectiveness?, control_note?, residual_likelihood?, residual_impact?, residual_override_reason?, clear_residual_override?, note? })`** reviews a risk. Only what is passed changes. Accepting or closing a risk needs a `note` saying why. An override needs all three of its fields.

**`list_risks({ subject_type, subject_id, status?, category?, risk_area?, residual_level?, overdue_only?, risk_id? })`** lists the register, highest residual score first, with:

- each risk's three scores (`inherent`, `control`, `residual`), each level in words;
- counts by status and of overdue reviews, and `residual_levels`: the risks not yet closed, by the level of their residual score;
- `level_names`: the platform's name for each level;
- `can_manage`: whether the caller may add and review.

`risk_area` is one area, or `unassigned` for risks with none. `residual_level` is `low`, `medium`, `high` or `critical`. With `risk_id`, the reply is that risk and its history; `get_risk` returns the same history with everything under the risk.

**`admin_list_risks({ limit?, subject_type?, risk_area?, residual_level? })`**, for Mynt admins, reads every register's risks that aren't closed: apps', products' and the platform's, or one kind, or one risk area, or `unassigned`. It returns:

- `counts` by inherent level and `residual_counts` by residual level (`critical`, `high`, `medium`, `low`), how many are overdue, and the total;
- the risks, highest residual score first, then by inherent score, then by review date, each with its three scores;
- for each risk, its `subject_name` and where it lives: `workspace_id` for an app's, `firm_id` for a product's, null for a reference product.

### One risk in full

**`get_risk({ risk_id })`** returns one risk with everything under it. Whoever reads the register reads it. Mynt admins also read any app's or product's risk this way, and never write it (`can_manage` is false).

| Part | What it holds |
| --- | --- |
| `risk` | The risk, with its three scores |
| `scoring` | Three lists of factors, `impact`, `likelihood` and `control`. Each has the score it explains (`recorded`), the factors' `average` (null when there are none), its `formula` in words and the `factors` |
| `treatments`, `treatment_due` | The treatment tasks, and the earliest due date among the open ones (null when none has one) |
| `controls` | The controls, retired ones included |
| `links` | What the risk is about |
| `history` | Every change, oldest first: when, who, what changed in words, the note, and the scores before and after (`score.before`, `score.after`, each `{ inherent, control, residual }`) |

A history entry from before three-step scoring carries the inherent score only. Its residual is null, "not recorded", never a guess.

### Factors, treatment tasks, controls and links

These are kept by whoever keeps the register, with the same rules as the register itself. Each write names the risk (`risk_id`).

**Factors** explain the three scores. They don't set them: the risk's likelihood, impact and control effectiveness change only with `update_risk`.

| Field | What it holds |
| --- | --- |
| `kind` | `impact`, `likelihood` or `control`: which score it explains |
| `name`, `rationale` | The factor in words, and why it scores as it does |
| `score` | 1 to 5. For impact and likelihood, as the risk's own. For a control factor, 1 is not working and 5 is working fully |
| `source` | Where it comes from: an `https` link, or something on Mynt as `type:id` (the types are the link targets below) |

- **`add_risk_factor({ risk_id, kind, name, score, rationale?, source? })`**
- **`update_risk_factor({ risk_id, factor_id, name?, score?, rationale?, source? })`**
- **`remove_risk_factor({ risk_id, factor_id })`**. The audit trail keeps what the factor was.

**Treatment tasks** are the work that brings the risk down.

| Field | What it holds |
| --- | --- |
| `title`, `owner`, `due` | The task, who owns it (someone on the register's side; by default whoever adds it) and when it is due. Past its due date and still open, it is `overdue` |
| `status` | `todo`, `doing`, `done` or `dropped`. Marking it done records `done_at` |
| `progress_note` | Where it stands, in words |
| `effectiveness`, `effectiveness_note` | Whether it worked: `not_assessed`, `ineffective`, `partly_effective` or `effective`. Saying it worked or didn't needs the task done |

- **`add_risk_treatment({ risk_id, title, owner_user_id?, due?, progress_note? })`**
- **`update_risk_treatment({ risk_id, treatment_id, title?, owner_user_id?, due?, status?, progress_note?, effectiveness?, effectiveness_note? })`**

**Controls** are what keeps the risk down. A control records what is in place; how well the controls work together is the risk's control effectiveness.

| Field | What it holds |
| --- | --- |
| `name`, `description` | The control and what it does |
| `kind` | `preventive` (stops it happening), `detective` (notices it) or `corrective` (puts it right) |
| `last_tested_at`, `test_result` | When it was last tested (not in the future) and the result: `passed`, `gaps_found` or `failed`. Null is not tested |
| `from_treatment` | The treatment task it was made from, when it was |
| `retired` | When and why it was retired. A retired control stays listed and can't be changed |

- **`add_risk_control({ risk_id, name?, kind, description?, last_tested_at?, test_result?, source_treatment_id? })`**. With `source_treatment_id`, the control is made from one of the risk's treatment tasks that is done, once, and takes the task's title unless a name is given.
- **`update_risk_control({ risk_id, control_id, name?, kind?, description?, last_tested_at?, test_result? })`**
- **`retire_risk_control({ risk_id, control_id, reason })`**

**Links** say what the risk is about.

| `target_type` | What it points at |
| --- | --- |
| `app`, `product`, `firm` | An app, a financial product or a firm |
| `vendor_offering` | A vendor's service |
| `agreement`, `agreement_audit` | An app's agreement, or an oversight audit under one |
| `audit_entry` | An audit-trail entry |
| `risk_model` | One of Mynt's risk models. Mynt admins only |

- **`link_risk({ risk_id, target_type, target_id, note? })`**. One link per risk and item.
- **`unlink_risk({ risk_id, link_id })`**

You can link what you can read: your own apps, products and firm, published products, listed vendor services, your agreements and their audits. A link's `name` is returned only to someone who may read what it points at. To anyone else it is null, the same whether the item exists or not.

## Risk grading

How risks are graded is one platform setting, `risk_grading`, read and changed by Mynt admins only. It holds:

| Part | What it holds | Default |
| --- | --- | --- |
| `levels` | The name of each of the four levels (`low`, `medium`, `high`, `critical`) | Low, Medium, High, Critical |
| `inherent_bands` | The inherent score's band for each level, `{ level, from, to }` | 1-4 low, 5-9 medium, 10-14 high, 15-25 critical |
| `residual_bands` | The residual score's bands, the same way | The same as the inherent bands |
| `residual_method` | `reduce` or `matrix` | `reduce` |
| `reduce` | For `reduce`: the share of the inherent score each control step takes away, 0 to 1 | none 0, weak 0.25, partial 0.5, strong 0.75 |
| `matrix` | For `matrix`: the residual level for each inherent level and control step | No control and a weak one leave the level; a partial one takes it one level down, a strong one two |

The two residual methods:

- **`reduce`:** residual = inherent × (1 − the step's reduction), rounded to the nearest whole number and never below 1. An inherent 20 with a partial control is 10.
- **`matrix`:** the inherent level and the control step pick a residual level. The residual score is the top of that level's residual band, or the inherent score when that is lower.

A grading is refused unless:

- each set of bands is the four levels in order, contiguous, starting at 1 and ending at 25;
- each level has its own name;
- a stronger control never reduces less than a weaker one, and no matrix cell is above its inherent level (a control never raises a risk).

**`get_risk_grading()`** returns the grading in force and its `version` (0 means Mynt's defaults, never changed), the method in words, the 5×5 likelihood × impact grid with each cell's score and level (`heat_map`), the defaults, and every version kept, newest first.

**`set_risk_grading({ levels?, inherent_bands?, residual_bands?, residual_method?, reduce?, matrix?, restore_version?, note })`** changes it, saying why. Pass what changes, or `restore_version` to bring back a kept version's content. Either way:

- it becomes a new version, and every earlier one is kept (the first change keeps Mynt's defaults as version 1);
- every residual score whose control is assessed and that isn't overridden is derived again;
- the audit trail records how many moved (`set_risk_grading`, with `residuals_changed`), and each moved risk's own history shows it (`rederive_risk_residual`).

### Signals around an app

For an app, `list_risks` also returns `signals`, what Mynt measures around it. Each is `{ available: true, rows }`, or `{ available: false, reason }` when Mynt doesn't measure it. It is never an empty list in its place.

| Signal | Rows |
| --- | --- |
| `fraud` | Not measured yet. Mynt records no fraud or velocity signals from customer sessions |
| `vendors` | The workspace's vendor services whose latest conformance run failed, whose calls mostly erred over the last 7 days, or whose subscription ended in the last 90 days; and the app's vendor contracts that were ended or ran out |
| `conduct` | Findings still open in the oversight audits licence providers run under the app's agreements, for requirements of the `marketing_review` and `complaints_review` kinds (see [Oversight audits](agreements.md#oversight-audits)) |
| `products` | The app's products with new sales paused by a licence provider's covenant, or drifted from their published composition |

### Audit and operations

- Every change is audited with the app's or product's id, in the obligations class, so it shows in the app's audit trail: `add_risk` and `update_risk`, and against the same risk `add_risk_factor`, `update_risk_factor`, `remove_risk_factor`, `add_risk_treatment`, `update_risk_treatment`, `add_risk_control`, `update_risk_control`, `retire_risk_control`, `link_risk` and `unlink_risk`. That trail is the risk's history.
- `ops_status` counts risks whose review date has passed and that aren't closed (`risks.overdue_reviews`), and says so under what needs attention. Overdue reviews of the platform's risks count with the others'.
- `remove_app` removes the app's register with it, and what each risk holds under it (factors, treatment tasks, controls and links). Each risk's history stays in the audit trail. A link from another register's risk to the removed app stays, without a name.

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
| `health`, `health_words` | Derived, in words. See below |
| `linked_risks` | How many risks on registers link to it (`link_risk` with `target_type: "risk_model"`) |

A validation's `outcome` is `passed`, `passed_with_findings` or `failed`.

A model's health is the first of these that holds:

| `health` | In words | When |
| --- | --- | --- |
| `retired` | Retired | The model is retired. It is never counted as unhealthy |
| `last_validation_failed` | Last validation failed | Its last validation's outcome is `failed` |
| `validation_overdue` | Validation overdue | Its next validation date has passed |
| `no_validation_yet` | No validation yet | It has never been validated |
| `healthy` | Healthy | None of the above |

### Risk model tools

**`add_risk_model({ risk_area, name, purpose, method, inputs?, outputs?, thresholds?, owner_user_id?, status?: "draft" | "active", next_validation_due? })`** adds a model at version 1, `draft` by default.

**`update_risk_model({ model_id, name?, purpose?, method?, inputs?, outputs?, thresholds?, owner_user_id?, status?, next_validation_due?, note? })`** changes a model that isn't retired.

- A change to what it is adds a version. The rest is carried over, and `note` is kept as its change note.
- Owner, status and due date change on the model itself.

**`validate_risk_model({ model_id, outcome, notes, next_validation_due })`** records a validation of the current version. Every one is kept. A failed one doesn't change the status.

**`retire_risk_model({ model_id, reason })`** retires a model. It stays listed with its history, can't be changed or validated, and is never overdue.

**`list_risk_models({ risk_area?, status?, model_id? })`** lists the models, newest first, with counts by status, of overdue validations and of models that aren't healthy (`not_healthy`). With `model_id`, the reply is that model, every version (oldest first), every validation (newest first) and `linked`: the risks that link to it, highest residual first, each with its source ("Mynt", "App: <name>" or "Product: <name>").

**`admin_list_product_risk_models({ query?, limit? })`** reads the risk models financial products declare in their definitions, across every firm. Each comes with its product (id, name, status) and its firm (none for a reference product). It is read-only.

### Audit and operations for risk models

- Every change is audited, in the obligations class: `add_risk_model`, `update_risk_model`, `validate_risk_model`, `retire_risk_model`.
- `ops_status` counts models past their next validation date (`risk_models.overdue_validations`, null on a server without them) and says so under what needs attention.
- `ops_status` also counts the models that aren't retired and aren't healthy (`risk_models.not_healthy`, with each one's name and health in `risk_models.unhealthy`), and names them under what needs attention.

## Risk in Studio

Risk shows in four places in Mynt Studio:

| Where | What it shows |
| --- | --- |
| An app's **Security & risk** tab | The app's risk register, among the tab's sections |
| A product's **Risk** tab, in the product workspace at `/products/<id>` | The product's risk register |
| The platform admin's **Risk register** section (`/platform/risk-register`) | Mynt's own register, one risk area per tab. Mynt admins only |
| The platform admin's **Risk models** section (`/platform/risk-models`) | Mynt's risk models, one risk area per tab. Mynt admins only |

A register is a table of risks: title, category, the three scores **Inherent**, **Control** and **Residual** (each level in words with its number; "Not assessed" for a control nobody has assessed), owner, status in words and review-by date, highest residual first. Whoever keeps the register (`can_manage`) has a labelled **Add risk** button and a **Review risk** button on each row, each opening a sheet. Review risk also sets the control's effectiveness and, when the derived score doesn't fit, the keeper's own residual with why.

### A risk's detail

A row opens the risk's detail, by a click or its labelled **Open**: in a sheet on an app's or a product's tab, and as its own page on the platform (`/platform/risk-register/<id>`). It is one component in all three places.

The metadata card is headed "‹short id› · ‹risk area› · ‹title›" with the status in words, and holds these facts in order:

| Fact | What it shows |
| --- | --- |
| Status | In words |
| Inherent | Likelihood × impact = score, with its level in words |
| Control | The control's effectiveness in words, or "Not assessed" |
| Residual | The score with its level in words; "overridden" when the keeper set it; "same as inherent" while the control isn't assessed |
| Owner | The owner, or "No owner" |
| Next review | The review date, with "overdue" in words once it has passed |
| Treatment due | The earliest due date among the open treatment tasks |
| Linked | How many items the risk links to |

Its actions are labelled buttons, each opening a sheet: **Review risk**, **Add treatment task**, **Add control**, **Link item**, **Close risk** and **Accept risk** (each needs a note), and **Copy link**. Someone who reads the register and doesn't keep it gets Copy link only.

Under the card are five tabs, each a table:

| Tab | Columns | Actions |
| --- | --- | --- |
| Scoring | Three tables, Impact factors, Likelihood factors and Control factors: Factor, Score, Rationale, Source, Action. Each table's caption states its formula in words, the score it explains and the factors' average | Add factor, Edit factor, Remove factor |
| Treatment | Task, Owner, Due, Status, Progress, Effectiveness, Action | Add treatment task, Update task, and Make this a control on a done task |
| Controls | Control, Kind, Last tested, Result, From task, Action | Add control, Update control, Retire control |
| Linked | Type, Item (linked where it has a page), Note, Action | Link item (a picker by type), Remove link |
| History | When, Who, What changed, Score before → after | None: it is read from the audit trail |

The routes are `GET` and `POST /api/apps/<appId>/risks/<riskId>`, `/api/products/<productId>/risks/<riskId>` and `/api/admin/risks/<riskId>`. A write must come from Studio's own origin, from a signed-in account with the route's role, and carries one action with that action's own fields. An app's or a product's route answers only for a risk on that app's or that product's register.

See [The platform admin in Studio](platform-admin.md#the-platform-admin-in-studio) for the two platform sections and for [Risk grading](platform-admin.md#platform-settings) in Platform settings.
