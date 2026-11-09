# Stage 10: Scope And Evidence

Stage ID: `S10_SCOPE_EVIDENCE`

## Objective

Build an auditable evidence map from Solana Rust code.

Use `./.exvul_solana_auditor/checklist.plan.min.json` to prioritize evidence tied to mapped rules.

## In-scope rules

- Include `*.rs` files under program source paths.
- Exclude generated/build/vendor folders.
- Track framework hints: `anchor`, `native`, or `mixed`.

## Evidence extraction checklist

Collect evidence lines for:

- signer checks (`Signer<'info>`, `.is_signer`)
- owner checks (`owner`, `spl_token::ID`, `require_*`)
- CPI calls (`invoke`, `invoke_signed`, program account typing)
- PDA logic (`find_program_address`, manual bump handling)
- init/reinit patterns (`init`, initialize functions, one-time guards)
- account close flow (`close =`, lamport drain, closed discriminator)
- remaining accounts validation (`remaining_accounts`, owner/signer/executable checks)

Also build file-level call relations:

- function callers/callees
- instruction entrypoints -> internal helpers
- account/state structs touched by each function

## Output files

Required downstream artifact:

- `./.exvul_solana_auditor/evidence.map.min.json`

Optional debug artifact:

- `./.exvul_solana_auditor/evidence.map.full.json`

`evidence.map.min.json`:

```json
{
  "framework": "anchor|native|mixed",
  "files": [
    {
      "path": "programs/foo/src/lib.rs",
      "line_count": 0,
      "functions": [
        {
          "name": "do_something",
          "line": 42,
          "callers": ["entrypoint_a"],
          "callees": ["helper_b"],
          "touches": ["VaultState"]
        }
      ],
      "signals": [
        {"name": "signal_name", "line": 42, "snippet": "code"}
      ]
    }
  ]
}
```

## Runtime progress output (required)

Follow `references/progress_protocol.md`.
Follow `references/output_budget.md`.

Emit:

- `stage_start` before file discovery
- `metric` for `files_total`, `files_done`, `functions_indexed`, `call_edges`
- `stage_end` with evidence extraction summary

In default `terse` mode, write heartbeat events to `events.ndjson` only.
