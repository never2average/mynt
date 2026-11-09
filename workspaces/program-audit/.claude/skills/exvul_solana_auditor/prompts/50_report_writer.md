# Stage 50: Report Writer

Stage ID: `S50_REPORT`

## Objective

Produce one high-quality, concise markdown report for user delivery.
This stage also finalizes checklist outcomes.

## Inputs

- `./.exvul_solana_auditor/checklist.plan.min.json`
- `./.exvul_solana_auditor/findings.validated.min.json`
- `./.exvul_solana_auditor/evidence.map.min.json`
- optional detail lookups from `*.full.json` (debug only)

## Required sections

1. Report header (title + metadata)
2. Executive snapshot (3-5 lines)
3. Findings (validated only)
4. Severity summary table
5. Checklist summary (counts only)
6. Triage summary
7. Prioritized remediation plan

## Integrated checklist finalization

Compute checklist status in this stage only.

Status resolution order:

1. Direct mapping by `finding.checklist_item_ids`
2. Fallback mapping by `finding.rule_id` intersecting `item.rule_ids`

Final status rules:

- `FAIL`: at least one validated finding maps to the checklist item.
- `PASS`: no validated finding maps to the checklist item.
- `UNKNOWN`: checklist unavailable or item metadata incomplete.

You may write `./.exvul_solana_auditor/checklist.result.full.json` for debug.

## Reporting constraints (quality + compactness)

- Do not include `false_positive` dropped findings.
- For `valid_downgraded`, include original severity, final severity, and reason.
- Sort findings by severity: Critical -> High -> Medium -> Low -> Informational.
- Keep prose concise, but include enough context to understand exploitability.
- Every finding must include: description, code excerpt, recommendation, and confidence.
- Use fenced code blocks for each finding (` ```rust ` preferred).
- Code excerpt must be a minimal relevant snippet (typically 3-20 lines), not whole files.

## Per-finding content contract (mandatory)

For every finding, include fields in this order:

1. `ID`
2. `File`
3. `Severity`
4. `Confidence`
5. `Description`
6. `Code` (fenced block)
7. `Recommendation`
8. `Notes` (optional)

## Required markdown shape

Use this structure:

```md
# Smart Contract Vulnerability Audit — <Project Name>

**Date:** YYYY-MM-DD
**Scope:** <project name or path>
**Files:** <count>
**Framework:** anchor|native|mixed

---

## Executive Snapshot

- Findings: total=<n> (Critical=<n>, High=<n>, Medium=<n>, Low=<n>, Info=<n>)
- Confidence: high-confidence=<n>, needs-manual-review=<n>
- Highest-risk theme: <one-line pattern>
- Immediate action: <one-line priority fix direction>

---

### [HIGH] <Finding Title>

**ID:** `<finding_id>`
**File:** `<path>` L<line> (or L<start>-L<end>)
**Severity:** `High` (or `Critical -> High` if downgraded)
**Confidence:** `0.82` (`high-confidence` or `needs-manual-review`)
**Description:** <1-3 sentences: exploit path + impact>

**Code:**
```rust
// minimal vulnerable/relevant snippet
```

**Recommendation:** <1-3 sentences with concrete fix direction>
**Notes:** <optional, include downgrade reason when applicable>

---

## Severity Summary

| Severity      | Count |
|---------------|-------|
| Critical      | 0     |
| High          | 0     |
| Medium        | 0     |
| Low           | 0     |
| Informational | 0     |

## Checklist Summary

| Status  | Count |
|---------|-------|
| PASS    | 0     |
| FAIL    | 0     |
| UNKNOWN | 0     |

## Triage

| Decision               | Count |
|------------------------|-------|
| valid                  | 0     |
| valid_downgraded       | 0     |
| false_positive_dropped | 0     |

## Prioritized Remediation

1. <P0 in 72h>
2. <P1 in 7d>
3. <P2 in 30d>
```

## Output file

Write:

- `./exvul_solana_auditor.md`

## Runtime progress output (required)

Follow `references/progress_protocol.md`.
Follow `references/output_budget.md`.

Emit:

- `stage_start` before render
- `metric` for severity counts + triage counts + confidence split
- `stage_end` with output file path

In default `terse` mode, keep final terminal summary to this block:

```text
Audit complete
Findings: total=<n> (Critical=<n> High=<n> Medium=<n> Low=<n> Info=<n>)
Confidence: high=<n> review=<n>
Triage: valid=<n> downgraded=<n> dropped=<n>
Checklist: pass=<n> fail=<n> unknown=<n>
Report: ./exvul_solana_auditor.md
```
