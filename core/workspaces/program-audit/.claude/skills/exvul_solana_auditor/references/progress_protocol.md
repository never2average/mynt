# Runtime Progress Protocol

Use this protocol for all runtime progress output.
Keep human output minimal and professional; final deliverable remains `./exvul_solana_auditor.md`.

## Runtime verbosity modes

- `terse` (default): terminal shows stage start/end and one stage summary.
- `normal`: terminal also shows compact milestones.
- `debug`: terminal may show per-file/per-window details.

In `terse`, heartbeats should be written to debug artifacts only.

## Dual-channel output

Emit progress in two synchronized forms:

1. Human terminal line (mode-dependent)
2. Structured event line (JSONL) to `./.exvul_solana_auditor/events.ndjson` (optional debug artifact)

## Human output rules (strict)

- Do not print full JSON payloads or file contents to the terminal.
- Do not echo checklist items or long descriptions in terminal output.
- No narrative paragraphs; only short status lines.
- Prefer totals over per-item lists.
- Respect per-stage output limits in `references/output_budget.md`.

## Stage IDs

- `S00_BOOTSTRAP`
- `S05_CHECKLIST_PLAN`
- `S10_SCOPE_EVIDENCE`
- `S15_DEEP_SWEEP`
- `S20_CANDIDATES`
- `S30_ADVERSARIAL_VERIFY`
- `S50_REPORT`

## Event types

- `stage_start`
- `heartbeat`
- `metric`
- `decision`
- `stage_end`

## Required event envelope

```json
{
  "ts": "2026-03-05T08:10:00Z",
  "stage": "S15_DEEP_SWEEP",
  "type": "heartbeat",
  "msg": "Scanning window 3/9",
  "progress": {"current": 3, "total": 9, "percent": 33.3},
  "counters": {"files_done": 4, "windows_done": 27, "candidates": 13}
}
```

## Terminal line format (compact)

```text
[S15][27/120|22%] file=programs/x/src/lib.rs window=3/9 candidates=13 kept=9 dropped=4
```

For short stages, use:

```text
[S05] checklist parsed: categories=11 items=47 mapped=8 ai=39
```

## Minimum heartbeat cadence

- Emit at least every 3 seconds during long-running stages.
- In `terse`, write heartbeat events to `events.ndjson` only.
- In `normal`/`debug`, emit heartbeat lines to terminal as well.
- Always emit verifier `decision` events (terminal in `normal`/`debug`, file-only in `terse`).

## Final rollup file

Write `./.exvul_solana_auditor/progress.json` with latest counters (optional debug artifact):

```json
{
  "current_stage": "S50_REPORT",
  "stage_percent": 100,
  "files_total": 0,
  "files_done": 0,
  "windows_total": 0,
  "windows_done": 0,
  "candidates": 0,
  "valid": 0,
  "valid_downgraded": 0,
  "false_positive_dropped": 0
}
```
