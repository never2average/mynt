---
name: maxwell-static-audit
description: Run Maxwell's static workflows headlessly against an application you must not modify, and report Maxwell's own counts.
---

# Maxwell static audit (read-only)

1. `git clone <maxwell_repo> ~/maxwell`, then in `~/maxwell`: `npm ci && npm run validate`.
2. Register a company "mynt-verify" and an application whose source is the local checkout at `app_dir`, with
   this machine as the scan executor.
3. Run only the static workflows, headless:
   - `execute-scr`, `probe-cicd-env`, `probe-agent-graph` and `probe-schemas`;
   - `probe-iac` and `probe-app-chart` too, if the application has infrastructure code or charts.
4. Read the counts and findings from Maxwell's findings records. List each workflow you ran under
   `workflows_run`, and each one you skipped (with the reason) under `skipped`.
5. Never fix anything. Report it, and leave `app_dir` exactly as you found it.
