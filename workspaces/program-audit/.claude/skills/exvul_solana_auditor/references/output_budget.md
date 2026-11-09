# Output Budget Policy

Use this file to constrain runtime token usage without reducing audit quality.

## Runtime modes

- `terse` (default): terminal prints stage start/end + one summary line.
- `normal`: terminal prints compact progress lines for major milestones.
- `debug`: terminal may include per-file/per-window progress and extra diagnostics.

## Terminal budgets (terse mode)

- `S00_BOOTSTRAP`: banner block from `references/banner.txt` + 1 status line
- `S05_CHECKLIST_PLAN`: max 2 lines
- `S10_SCOPE_EVIDENCE`: max 2 lines
- `S15_DEEP_SWEEP`: max 3 lines
- `S20_CANDIDATES`: max 2 lines
- `S30_ADVERSARIAL_VERIFY`: max 2 lines
- `S50_REPORT`: max 6 lines (final summary block)

Heartbeat events should be written to debug artifacts, not terminal, in `terse` mode.

## Artifact budgets (min schema)

Stage outputs consumed by downstream stages must use `*.min.json` with only required fields.
Long text fields (`description`, `remediation`, long snippets) belong only in `*.full.json` and only when debug output is requested.

Recommended max fields per object in `*.min.json`:

- checklist item: 5 fields
- evidence signal: 4 fields
- candidate finding: 12 fields
- validated finding: 12 fields

## Report quality floor

The final report is concise, but every finding must keep:

- clear exploit impact (one line)
- concrete evidence pointer (file + line + short signal)
- actionable fix (one line)
- confidence and decision outcome

Concise output must not remove exploitability clarity.
