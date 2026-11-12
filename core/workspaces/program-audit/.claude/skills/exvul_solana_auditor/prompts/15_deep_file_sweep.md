# Stage 15: Deep File Sweep (Sink-First)

Stage ID: `S15_DEEP_SWEEP`

## Objective

Independently discover real, exploitable vulnerabilities across every in-scope Rust file,
not limited to checklist or predefined rule IDs.

## Mandatory sweep protocol

For every in-scope file:

1. Run a lightweight pass to identify high-risk sinks:
   - CPI calls, signer forwarding, owner changes, unchecked account handling, init/close paths.
2. Deep-analyze high-risk functions first using function-level windows.
3. Use small overlap (`20-40` lines) for function-level windows.
4. Fallback to 1000-line windows (120 overlap) only when function boundaries are unclear.
5. No in-scope file can be skipped.

## Context package per window

Each deep-review window must include:

1. code window (function-level preferred; hard cap `<=1000` lines)
2. local call graph context from `evidence.map.min.json`:
   - direct callers
   - direct callees
   - touched accounts/state structs
3. security assumptions inferred from adjacent windows

## Analysis policy

- Focus on real exploitability, not style issues.
- A finding must include concrete attack path and required preconditions.
- If exploitability is unclear, mark lower confidence.
- Avoid duplicate findings across windows.
- Keep intermediate finding text compact in `*.min.json`; move long rationale to `*.full.json` (debug only).
- For each candidate, attach best-effort `checklist_item_ids` from `checklist.plan.min.json`.
  - Use direct semantic match against checklist item title and expected evidence hints.
  - If no match, keep `checklist_item_ids: []`.

## Runtime progress output (required)

Follow `references/progress_protocol.md`.
Follow `references/output_budget.md`.

Emit:

- `stage_start` before first file
- per-file `metric`: `file_index`, `files_total`, `high_risk_sinks`
- per-file `metric`: `file_candidates`, `file_kept`, `file_dropped`
- `stage_end` with `files_analyzed`, `windows_analyzed`, `total_candidates`

In default `terse` mode, write heartbeat events to `events.ndjson` only.

## Output files

Required downstream artifact:

- `./.exvul_solana_auditor/deep_sweep.findings.min.json`

Optional debug artifact:

- `./.exvul_solana_auditor/deep_sweep.findings.full.json`

`deep_sweep.findings.min.json`:

```json
{
  "summary": {
    "files_analyzed": 0,
    "windows_analyzed": 0,
    "total_candidates": 0
  },
  "findings": [
    {
      "source": "deep_sweep",
      "finding_id": "AI-001",
      "rule_id": "SOL-R003",
      "checklist_item_ids": ["CL-IV-01"],
      "title": "CPI target can be attacker controlled via unchecked program account",
      "severity": "Critical",
      "file": "programs/x/src/lib.rs",
      "line": 123,
      "window": {"start": 1, "end": 1000},
      "exploit_path": "attacker-controlled account flows into invoke target",
      "preconditions": ["caller can pass arbitrary account"],
      "evidence": ["line 123 invoke", "line 140 unchecked account"],
      "confidence": 0.82,
      "status": "high-confidence"
    }
  ]
}
```
