---
name: exvul_solana_auditor
description: "Prompt-only Solana security audit skill. Run one autonomous full audit, adversarially remove false positives, and output exvul_solana_auditor.md."
---

# exvul_solana_auditor

This is a prompt-first Claude Code skill.
The workflow is executed by prompt orchestration, not script orchestration.

## Invocation Contract

Use one invocation style:

- `/exvul_solana_auditor`

The skill must scan the repository end-to-end and produce a final report.

## Execution Contract

Always execute these stages in order:

1. Run bootstrap first (`prompts/00_bootstrap.md`).
2. Checklist planning (`prompts/05_checklist_plan.md`).
3. Scope + evidence extraction (`prompts/10_scope_and_evidence.md`).
4. Deep file sweep (sink-first, function-level preferred) (`prompts/15_deep_file_sweep.md`).
5. Candidate finding generation (`prompts/20_candidate_generation.md`).
6. Adversarial verifier pass (`prompts/30_adversarial_verifier.md`).
7. Report publishing (includes final checklist computation) (`prompts/50_report_writer.md`).

Checklist policy:

- Default checklist index: `<skill-root>/knowledge/checklists/default/index.md`
- Category details (lazy-load): `<skill-root>/knowledge/checklists/default/categories/CAT-*.md`
- Legacy fallback checklist: `<skill-root>/knowledge/checklists/default.md`
- If missing: continue, mark checklist as unavailable.
- Parse checklist as-is; do not rewrite user-authored checklist content.

## Required Output

Required deliverable:

- `./exvul_solana_auditor.md` (final user-facing report)

Optional debug artifacts under `./.exvul_solana_auditor/` may be produced, but should not be required for completion.

Final response to user must include:

1. total findings
2. severity distribution
3. `high-confidence` vs `needs-manual-review`
4. triage summary (`valid`, `valid_downgraded`, `false_positive_dropped`)
5. final report path (`./exvul_solana_auditor.md`)

## Prompt Protocol

Adversarial verification is mandatory and isolated per finding:

- Start with assumption: "likely false positive."
- Allowed context:
  - finding payload
  - local code excerpt near finding line
- Decision must be exactly one:
  - `false_positive` -> remove
  - `valid` -> keep
  - `valid_downgraded` -> keep + severity downgrade + explanation

Checklist linkage rule:

- `S05` reads checklist index first and builds a lite checklist plan.
- `S05` keeps only minimal per-item fields to reduce token use.
- `S15` and `S20` should attach `checklist_item_ids` to findings whenever possible.
- `S50` computes checklist result by `checklist_item_ids` first, then `rule_id` fallback.

Checklist ordering rule:

- `Checklist-Plan` happens before evidence and candidate generation.
- Final checklist PASS/FAIL is computed inside report publishing after adversarial verification.

Deep sweep rule:

- Every in-scope file must be analyzed.
- Prefer sink-first analysis: lightweight pass over all files, then deep analysis on high-risk sinks.
- Deep analysis should use function-level windows first; only fall back to 1000-line windows when needed.
- Findings from deep sweep and rulepack must be merged before adversarial verification.

Use templates from `prompts/` and policy from `knowledge/`.

Runtime visualization rule:

- Follow `references/progress_protocol.md`.
- Default runtime mode is `terse`:
  - terminal: stage start/end + stage summary only
  - heartbeat: write to debug artifacts only
- Use `normal`/`debug` only when explicitly requested.
- Follow per-stage output budgets from `references/output_budget.md`.

Intermediate artifact rule:

- For each stage, write `*.min.json` for downstream stages.
- Write `*.full.json` only when debug mode is enabled.

## Resource Map

- Workflow: `references/workflow.md`
- Progress protocol: `references/progress_protocol.md`
- Output budgets: `references/output_budget.md`
- Banner asset: `references/banner.txt`
- Prompt templates: `prompts/*.md`
- Rule knowledge: `knowledge/rulepack.md`
- Checklist router: `knowledge/checklist_router.md`
- Severity policy: `knowledge/severity_policy.md`
- Checklist index: `knowledge/checklists/default/index.md`
