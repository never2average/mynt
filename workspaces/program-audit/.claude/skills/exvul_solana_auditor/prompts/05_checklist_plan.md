# Stage 05: Checklist Plan (Pre-Analysis)

Stage ID: `S05_CHECKLIST_PLAN`

## Objective

Load checklist index first and build a low-token coverage plan.
This stage defines coverage intent only (no PASS/FAIL yet).

## Inputs

- `<skill-root>/knowledge/checklists/default/index.md` (primary)
- `<skill-root>/knowledge/checklists/default/categories/CAT-*.md` (lazy detail only)
- `<skill-root>/knowledge/checklists/default.md` (legacy fallback)
- `knowledge/rulepack.md`
- `knowledge/checklist_router.md` (optional but preferred)

## Parsing contract (index-first)

Primary path:

1. Read `index.md`.
2. Parse category table under `## Categories`.
3. Parse item lists under `## Items`.

Fallback path:

- If `index.md` is missing, parse legacy `default.md` headings (`## Roman`, `### Number`) and continue.

Do not rewrite checklist text. Build normalized metadata in memory only.

## Stable internal IDs

- Use item IDs from `index.md` directly when present (for example `CL-IV-01`).
- If fallback parsing is used, generate deterministic IDs by encounter order:
  - category: `CAT-<Roman>`
  - item: `CL-<Roman>-<2-digit-number>`

## Mapping policy

For each checklist item title:

1. Explicit mapping:
   - if title contains `SOL-Rxxx`, use it directly.
   - `mapping_mode = "explicit"`.
2. Inferred mapping:
   - infer from title keywords using `knowledge/checklist_router.md`.
   - fallback to `knowledge/rulepack.md` keyword inference when router is absent.
   - `mapping_mode = "inferred"`.
3. AI-only coverage:
   - when rulepack has no suitable rule, set `rule_ids = ["SOL-AI"]`.
   - `mapping_mode = "ai_only"`.

Populate only minimal evidence hints:

- `expected_evidence`: short code signals for later stages.

## Lazy detail loading

- Do not load category detail markdown by default.
- Load `categories/CAT-*.md` only when a later stage needs exact description/remediation wording.
- Keep loaded detail in `*.full.json` only (debug mode).

## Important constraints

- Do NOT assign `PASS` / `FAIL` / `UNKNOWN` in this stage.
- This stage must succeed even if checklist style is verbose.
- If checklist is missing, emit an empty plan with `available: false`.
- Write plan artifacts in a single write operation per file.
- Do not print checklist item details to terminal.
- If direct write fails, retry once via shell heredoc.
- Never abort this stage on first write failure; recover and continue.
- Follow `references/output_budget.md`.

## Output files

Ensure `./.exvul_solana_auditor/` exists before writing.

Required downstream artifact:

- `./.exvul_solana_auditor/checklist.plan.min.json`

Optional debug artifact:

- `./.exvul_solana_auditor/checklist.plan.full.json`

### `checklist.plan.min.json` schema

```json
{
  "summary": {
    "available": true,
    "total_categories": 0,
    "total_items": 0,
    "explicit_mappings": 0,
    "inferred_mappings": 0,
    "ai_only_items": 0
  },
  "categories": [
    {"id": "CAT-I", "title": "Access Control Category", "item_count": 5}
  ],
  "items": [
    {
      "id": "CL-I-01",
      "title": "Missing Signer Check/Verification",
      "rule_ids": ["SOL-R001"],
      "mapping_mode": "inferred",
      "expected_evidence": ["Signer<'info>", ".is_signer", "require!(...is_signer)"]
    }
  ]
}
```

Fallback shell write template:

```sh
mkdir -p ./.exvul_solana_auditor
cat > ./.exvul_solana_auditor/checklist.plan.min.json <<'JSON'
{ ...valid JSON content... }
JSON
```

## Runtime progress output (required)

Follow `references/progress_protocol.md`.

In default `terse` mode emit only:

- `stage_start` at checklist parse start
- `metric` summary (`total_categories`, `total_items`, mappings)
- `stage_end` with planning summary

Write heartbeat details to `events.ndjson` only.
