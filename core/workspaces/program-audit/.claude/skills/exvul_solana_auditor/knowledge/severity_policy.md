# Severity Policy

Use this policy during `valid_downgraded` decisions.

## Downgrade rules

- Downgrade only when exploitability or impact is materially constrained by observed guards.
- Never downgrade without quoting concrete local evidence.
- Allowed downgrade step is one or more levels down:
  - Critical -> High -> Medium -> Low -> Informational

## Confidence status

- `high-confidence`: confidence >= 0.75
- `needs-manual-review`: confidence < 0.75

## Triage outcome semantics

- `false_positive`: remove finding from final set.
- `valid`: keep finding as-is.
- `valid_downgraded`: keep finding with reduced severity and explanation.
