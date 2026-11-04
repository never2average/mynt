---
name: model-contract
description: The contract every product-desk model must follow so Mynt's runner can find, run and check it (models/<name>/model.json, MYNT_INPUT/MYNT_OUTPUT, report shape, tests).
---

# The model contract

Each model lives in `models/<name>/` in the firm's repository.

**`model.json`**
```json
{ "name": "consumer-loan-pricing", "description": "...",
  "applies_to": { "product_lines": ["credit"], "categories": ["personal-loans"] },
  "inputs": [{ "key": "apr_pct", "required": true, "unit": "%", "description": "..." }],
  "run": "python3 main.py",
  "requirements": "requirements.txt" }
```
- `applies_to` can name lines and/or categories. A model that names a category wins over one that names only the
  line.
- Lines are Mynt's line ids, by economic function: `credit`, `securitization`, `payments`, `account_operations`,
  `custody_settlement`, `wealth`, `insurance`, `guarantees_trade`, `exchange`, `derivatives`, `information`. A
  deposit model applies to `account_operations`; a bond or T-bill model to `credit` (with category `bonds` or
  `money_market`); a fixed-deposit model, for example:
  `"applies_to": { "product_lines": ["account_operations"], "categories": ["deposits"] }`.
- Input keys are lower snake case, matching the term sheet's `inputs`.

**The code**
- It reads the JSON at `$MYNT_INPUT`: `{ product, inputs, assumptions, regulatory }`.
- It writes `$MYNT_OUTPUT`:
  ```json
  { "verdict": "feasible | marginal | infeasible", "summary": "...",
    "metrics": { "net_margin_pct": 4.6 },
    "checks": [{ "name": "rate_cap", "status": "pass | warn | fail", "detail": "...", "legal_ref": "..." }],
    "scenarios": [{ "name": "pd_x2", "metrics": { "net_margin_pct": 2.2 } }],
    "assumptions": { "...": "..." } }
  ```
- Mynt rejects a report without a valid verdict, summary, metrics and checks.

**Tests:** `pytest` tests for the core calculations, in `models/<name>/tests/`.

**Verdicts:**
- `feasible`: holds under the stress scenarios.
- `marginal`: positive in the base case, but not under stress.
- `infeasible`: doesn't work even in the base case, or breaches a regulatory limit.

**Decision algorithms (optional `decide`).** A model a product's `core_algorithms` points at (eligibility,
underwriting, limit assignment, pricing, fraud screening) may also declare `"decide": "python3 decide.py"` in
`model.json`. Mynt runs it with:
- `$MYNT_APPLICANTS`: a JSONL file, one applicant per line: `id` plus features (`segment`, `employment_type`,
  `monthly_income`, `bureau_score` (null when there is no history), `existing_obligations`, `tenure_months`,
  `region`, `requested_amount`, `application_month`);
- and it must write `$MYNT_DECISIONS`: JSONL, one line per applicant:
  `{ "id": "...", "approve": true, "limit": 150000, "apr_pct": 19.5, "grade": "B", "reason_codes": [] }`.
  `limit`, `apr_pct` and `grade` as they apply; every decline carries at least one reason code.

The algorithm never receives outcome labels or protected attributes, and must not try to infer them.
