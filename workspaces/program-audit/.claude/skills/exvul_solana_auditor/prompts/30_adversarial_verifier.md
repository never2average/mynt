# Stage 30: Adversarial Verifier

Stage ID: `S30_ADVERSARIAL_VERIFY`

## Objective

Remove false positives and downgrade overstated findings through isolated, fresh reviews.

## Core stance (mandatory)

For each finding, start from:

- "This is likely a false positive unless local evidence proves exploitability."

## Isolation constraints (mandatory)

Each finding must be verified by a fresh reviewer instance with no carry-over context.

Allowed input per finding:

1. finding payload
2. local code excerpt around `file:line`

Disallowed:

- cross-finding memory
- global conclusions imported from previous decisions
- optimistic assumptions without direct local evidence

Applies to:

- rulepack-derived candidates
- deep-file-sweep-derived candidates

Primary input:

- `./.exvul_solana_auditor/findings.candidates.min.json`

## Required decision schema

```json
{
  "decision": "false_positive | valid | valid_downgraded",
  "downgraded_severity": "Critical|High|Medium|Low|Informational|",
  "confidence": 0.0,
  "confidence_basis": "what evidence made confidence high/medium/low",
  "explanation": "short technical rationale"
}
```

Confidence rule:

- Do not reuse fixed defaults.
- Set confidence from evidence quality:
  - exploit path complete + strong local proof -> higher confidence
  - missing preconditions or uncertain control flow -> lower confidence

## Decision application

- `false_positive`: remove from final findings.
- `valid`: keep unchanged.
- `valid_downgraded`: keep with lower severity and explicit severity transition.

## Output files

Required downstream artifact:

- `./.exvul_solana_auditor/findings.validated.min.json`

Optional debug artifact:

- `./.exvul_solana_auditor/findings.validated.full.json`

`findings.validated.min.json`:

```json
{
  "summary": {
    "valid": 0,
    "valid_downgraded": 0,
    "false_positive_dropped": 0
  },
  "findings": [
    {
      "finding_id": "CAND-001",
      "rule_id": "SOL-R003",
      "checklist_item_ids": ["CL-IV-01"],
      "decision": "valid_downgraded",
      "original_severity": "Critical",
      "final_severity": "High",
      "confidence": 0.71,
      "confidence_basis": "CPI target is user-controlled but privileged signer is constrained",
      "explanation": "impact remains high but not critical due to signer guard"
    }
  ],
  "dropped": []
}
```

## Runtime progress output (required)

Follow `references/progress_protocol.md`.
Follow `references/output_budget.md`.

Emit:

- `stage_start` before first finding review
- `metric` summary: `valid`, `valid_downgraded`, `false_positive_dropped`
- `stage_end` with verifier totals

In default `terse` mode:

- write per-finding `decision` and heartbeat events to `events.ndjson` only
- keep terminal output to stage summary metrics
