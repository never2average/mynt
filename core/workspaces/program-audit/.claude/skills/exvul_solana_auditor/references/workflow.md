# Workflow

This skill has one execution style: full autonomous audit.

## Prompt-Orchestrated Flow

1. Bootstrap and banner (`prompts/00_bootstrap.md`)
2. Checklist planning (`prompts/05_checklist_plan.md`)
3. Scope + evidence extraction (`prompts/10_scope_and_evidence.md`)
4. Deep file sweep (sink-first, function-level windows preferred) (`prompts/15_deep_file_sweep.md`)
5. Candidate finding generation (`prompts/20_candidate_generation.md`)
6. Adversarial verifier pass per finding (`prompts/30_adversarial_verifier.md`)
7. Final report rendering (`prompts/50_report_writer.md`, includes checklist finalization)

Default checklist source:

- `<skill-root>/knowledge/checklists/default/index.md`
- lazy detail files: `<skill-root>/knowledge/checklists/default/categories/CAT-*.md`
- fallback: `<skill-root>/knowledge/checklists/default.md`

Adversarial reviewer:

- policy: false-positive-first review per finding
- output decisions: `false_positive`, `valid`, `valid_downgraded`

Checklist timing:

- `checklist.plan.min.json` is generated before analysis as coverage intent.
- `checklist.plan.full.json` is optional debug output only.
- final checklist outcome is computed during report rendering.
- checklist text remains unchanged; IDs are generated internally.

Deep sweep timing:

- `deep_sweep.findings.min.json` is generated after evidence mapping.
- `deep_sweep.findings.full.json` is optional debug output only.
- Candidate generation merges deep sweep + rulepack candidates.
- findings should carry `checklist_item_ids` when linkable.

Reference assets:

- `prompts/*.md`
- `references/progress_protocol.md`
- `references/output_budget.md`
- `references/banner.txt`
- `knowledge/rulepack.md`
- `knowledge/checklist_router.md`
- `knowledge/severity_policy.md`

## Outputs

- Final report: `./exvul_solana_auditor.md`
- Optional debug artifacts directory: `./.exvul_solana_auditor/`
