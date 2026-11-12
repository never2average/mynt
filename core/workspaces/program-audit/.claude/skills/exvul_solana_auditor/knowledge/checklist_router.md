# Checklist Router (Keyword to Rule Mapping)

Use this file in `S05_CHECKLIST_PLAN` to map natural-language checklist items to current rulepack IDs.
This router is for inference only; it does not modify checklist text.

## Mapping priority

1. Explicit `SOL-Rxxx` in checklist text
2. Router keyword mapping in this file
3. Fallback to `SOL-AI` when no rulepack-equivalent exists

## Router table

| Keyword patterns (title/description) | Rule ID | Detectability | Notes |
|---|---|---|---|
| signer, is_signer, privileged account signer | SOL-R001 | rulepack | Missing signer authorization |
| owner check, account.owner, token owner program | SOL-R002 | rulepack | Owner/program ownership validation |
| arbitrary cpi, arbitrary program invocation, invoke target | SOL-R003 | rulepack | CPI target program pinning |
| duplicate mutable, same account as source and destination | SOL-R004 | rulepack | Mutable alias conflict |
| canonical bump, find_program_address, pda bump validation | SOL-R005 | rulepack | PDA canonical bump enforcement |
| re-initialization, initialize twice, missing init guard | SOL-R006 | rulepack | Unsafe re-init path |
| remaining_accounts, unchecked extra accounts | SOL-R007 | rulepack | Remaining accounts trust checks |
| improper close, revival after close, manual close hardening | SOL-R008 | rulepack | Account close hardening |
| lamport transfer, rent-exemption, executable account transfer, write-demotion, reserved account | SOL-R009 | rulepack | Lamport transfer to unvalidated recipient |
| signer privilege, signer forwarding, cpi signer passthrough, signer reuse | SOL-R010 | rulepack | CPI signer privilege forwarding |
| ownership reassignment, assign instruction, account owner change, owner after cpi | SOL-R011 | rulepack | Account ownership reassignment via CPI |
| token-2022, token extension, permanent delegate, transfer hook, transfer fee bypass, mint close, default account state, cpi guard, dynamic account size | SOL-R012 | rulepack | Token-2022 extension security |
| frontrunning, transaction ordering, expected price, slippage, sandwich | SOL-R013 | rulepack | Frontrunning / transaction ordering |
| abi decode, borsh decode, payload length, input validation, non-strict bool, partial selector, discriminator match, unchecked slice | SOL-R014 | rulepack | Unsafe data encoding/decoding |
| event emit, log data, emit_cpi, untrusted event parameter, event integrity | SOL-R015 | rulepack | Event/log data integrity |

## AI-only buckets (`SOL-AI`)

When checklist item falls outside current rulepack coverage, map to `SOL-AI`.
Examples:

- weak access control policy design
- authority transfer governance
- writable flag checks
- account type cosplay / relational data mismatch (general forms)
- arithmetic precision and casting risks (beyond multiplication-before-division)
- CPI reentrancy modeling
- PDA sharing/seed-collision/substitution variants not captured by `SOL-R005`
- panic/unsafe/error-handling quality
- randomness and oracle trust model
- DoS complexity and compute exhaustion (beyond lamport transfer pitfalls)
- testing/deployment process controls
- timely state reset / stale intermediate state
- cross-chain trusted chain/address validation
- inconsistent state update guards / no-op updates
- custom type trait derivation (Ord, PartialOrd) correctness
- orphan account lifecycle dependency management

## Expected evidence hints

Use these hints to fill `expected_evidence` in `checklist.plan.min.json`:

- signer/auth: `Signer<'info>`, `.is_signer`, `require!(...is_signer)`
- ownership: `account.owner`, `spl_token::ID`, `Program<'info, Token>`
- CPI: `invoke`, `invoke_signed`, program account constraints
- PDA: `find_program_address`, seeds/bump checks
- init/close: `init`, initialized flag, `close =`, zeroing/discriminator handling
- remaining accounts: `remaining_accounts` loop + owner/signer/executable validations
- lamport transfer: `**account.lamports.borrow_mut()`, `transfer`, `is_exempt`, `.executable`, reserved account checks
- CPI signer: `is_signer` on CPI account infos, balance pre/post checks, `.owner` post-CPI checks
- ownership reassignment: `system_instruction::assign`, post-CPI `account.owner == system_program::ID`
- Token-2022: `get_extension`, `PermanentDelegate`, `TransferHook`, `DefaultAccountState`, `MintCloseAuthority`, `getExtensionTypes`, `reallocate`, `CpiGuard`
- frontrunning: `expected_price`, `min_amount_out`, slippage bounds, upgrade authority init restriction
- data encoding: `data.len()`, `abi_decode`, `BorshDeserialize`, `try_from_slice`, `.get(..N)`, strict bool checks, full selector comparison
- event integrity: `emit_cpi!`, event fields sourced from `ctx.accounts.*` vs instruction params
