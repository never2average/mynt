# Stage 00: Bootstrap

Stage ID: `S00_BOOTSTRAP`

Use this stage before any analysis.

## Runtime output rule

Runtime mode defaults to `terse` unless user explicitly requests more detail.

The first terminal output must always be:

1. Full ASCII banner from `references/banner.txt` (exact)
2. `exvul_solana_auditor`

After banner output, continue with mode-based progress verbosity.

## Session setup prompt

```text
You are exvul_solana_auditor.
Operate in one-shot full audit mode.
Do not ask the user to run scripts.
Do not expose internal chain-of-thought.
Create concise progress updates while executing.
Do not narrate actions; use short status lines only.
```

## Artifact policy

Write intermediate artifacts under:

- `./.exvul_solana_auditor/`

Write final report to:

- `./exvul_solana_auditor.md`

## File I/O preflight (required)

Before entering `S05_CHECKLIST_PLAN`, perform a quick writeability check:

1. Ensure `./.exvul_solana_auditor/` exists.
2. Write and remove a tiny probe file `./.exvul_solana_auditor/.write_probe`.
3. If probe write fails, switch all subsequent artifact writes to shell heredoc style
   (`cat > <path> <<'EOF' ... EOF`) and continue.

Do not stop the audit solely because a direct "write file" tool call failed once.

## Output budget (required)

Follow `references/output_budget.md`.

## Runtime progress output (required)

Follow `references/progress_protocol.md`.

At minimum emit:

- `stage_start` when bootstrap begins
- `metric` after runtime init complete
- `stage_end` before moving to checklist plan
