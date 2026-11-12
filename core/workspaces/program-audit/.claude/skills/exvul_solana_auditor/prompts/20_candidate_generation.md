# Stage 20: Candidate Generation

Stage ID: `S20_CANDIDATES`

## Objective

Generate candidate findings from evidence map + rulepack knowledge.

Use:

- `knowledge/rulepack.md`
- `./.exvul_solana_auditor/evidence.map.min.json`
- `./.exvul_solana_auditor/checklist.plan.min.json`
- `./.exvul_solana_auditor/deep_sweep.findings.min.json`

## Generation policy

- One finding = one concrete rule/file/location claim.
- Prefer findings that map to checklist plan coverage targets.
- Include deep-sweep discoveries even when they do not map to checklist.
- Prefer precise line references and evidence snippets.
- Avoid duplicates across same `rule_id + file + line + title`.
- Confidence is preliminary in this stage.

When a finding is not covered by predefined rule IDs:

- set `rule_id` to `SOL-AI`
- keep strong exploit-path rationale

Checklist linking requirements:

- Every candidate must include `checklist_item_ids` (array).
- Link by:
  1. deep-sweep provided IDs first
  2. otherwise infer from `checklist.plan.min.json` item semantics
- If still no reliable match, use empty array.

## Output files

Required downstream artifact:

- `./.exvul_solana_auditor/findings.candidates.min.json`

Optional debug artifact:

- `./.exvul_solana_auditor/findings.candidates.full.json`

`findings.candidates.min.json`:

```json
{
  "summary": {"total_candidates": 0},
  "findings": [
    {
      "finding_id": "CAND-001",
      "source": "rulepack|deep_sweep|merged",
      "rule_id": "SOL-R001",
      "checklist_item_ids": ["CL-I-01"],
      "title": "Missing signer authorization for privileged account",
      "severity": "High",
      "file": "programs/x/src/lib.rs",
      "line": 12,
      "description": "why this might be vulnerable",
      "recommendation": "fix guidance",
      "exploit_path": "attacker path",
      "evidence_signals": [{"name": "signal", "line": 12, "snippet": "code"}],
      "confidence": 0.78,
      "status": "high-confidence"
    }
  ]
}
```

## Runtime progress output (required)

Follow `references/progress_protocol.md`.
Follow `references/output_budget.md`.

Emit:

- `stage_start` before merge
- `metric` for `rulepack_candidates`, `deep_sweep_candidates`, `linked_to_checklist`, `dedup_removed`, `total_candidates`
- `stage_end` with candidate summary

In default `terse` mode, skip terminal heartbeat details.
