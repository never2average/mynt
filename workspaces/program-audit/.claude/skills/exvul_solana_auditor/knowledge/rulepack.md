# Rulepack Knowledge (Prompt Use)

This rulepack is consumed by prompt stages, not code execution.

## SOL-R001

- Title: Missing signer authorization for privileged account
- Severity default: High
- Trigger idea: privileged account appears unchecked/untyped and no signer verification is present
- Counter-evidence: explicit signer type or runtime signer check

## SOL-R002

- Title: Token account owner program is not verified
- Severity default: High
- Trigger idea: token-like account data is trusted without owner-program validation
- Counter-evidence: owner checks or typed token program constraints

## SOL-R003

- Title: CPI target program can be attacker-controlled
- Severity default: Critical
- Trigger idea: CPI invoke path with untyped or unpinned target program account
- Counter-evidence: strict program ID pinning or typed program accounts

## SOL-R004

- Title: Duplicate mutable account alias is not prevented
- Severity default: Medium
- Trigger idea: two mutable slots can reference same account without inequality guard
- Counter-evidence: explicit key inequality checks

## SOL-R005

- Title: Manual PDA validation may skip canonical bump enforcement
- Severity default: High
- Trigger idea: manual PDA bump handling without canonical bump verification
- Counter-evidence: canonical `find_program_address` or equivalent enforced seeds+bump pattern

## SOL-R006

- Title: Initialization path appears re-initializable
- Severity default: High
- Trigger idea: initialization logic lacks one-time guards or safe init constraints
- Counter-evidence: explicit initialized checks or robust init constraints

## SOL-R007

- Title: remaining_accounts are used without trust validation
- Severity default: High
- Trigger idea: remaining accounts consumed without owner/signer/executable checks
- Counter-evidence: clear validation before trust-sensitive use

## SOL-R008

- Title: Manual account close flow lacks hardening
- Severity default: Medium
- Trigger idea: manual close flow without safe close constraints/discriminator handling
- Counter-evidence: close constraints and hardened close markers

## SOL-R009

- Title: Lamport transfer to unvalidated recipient
- Severity default: Medium
- Trigger idea: lamport transfer to arbitrary/user-supplied account without checking rent-exemption, executable status, or write-demotion
- Counter-evidence: explicit rent-exemption check, executable flag check, and reserved account validation before transfer; or transfer to program-owned PDA vault

## SOL-R010

- Title: CPI signer privilege forwarding without safeguards
- Severity default: High
- Trigger idea: signer-privileged account passed into CPI to untrusted/arbitrary program without verifying signer flags on CPI accounts or checking balance/ownership post-CPI
- Counter-evidence: explicit signer flag stripping on CPI accounts, balance checks before/after CPI, ownership verification post-CPI

## SOL-R011

- Title: Account ownership reassignment via CPI
- Severity default: Critical
- Trigger idea: CPI to untrusted program with signed account that could be reassigned via `system_instruction::assign`; no post-CPI owner verification
- Counter-evidence: post-CPI check that `account.owner == system_program::ID`; no signer-privileged accounts passed to arbitrary CPIs

## SOL-R012

- Title: Token-2022 extension security misconfiguration
- Severity default: High
- Trigger idea: program interacts with Token-2022 mints without checking extensions (permanent delegate, transfer hook, default account state, mint close authority); hardcoded token account sizes
- Counter-evidence: explicit extension checks, dynamic size calculation, trust verification for permanent delegate, transfer hook mint validation

## SOL-R013

- Title: Frontrunning / transaction ordering vulnerability
- Severity default: Medium
- Trigger idea: instruction modifies or reads on-chain state (e.g., price, authority) without expected-value guards, allowing manipulation via transaction ordering
- Counter-evidence: expected-value parameters (e.g., `expected_price`, `min_amount_out`), slippage protection, initialization restricted to upgrade authority

## SOL-R014

- Title: Unsafe data encoding/decoding of untrusted input
- Severity default: Medium
- Trigger idea: ABI/Borsh/raw byte deserialization without input length validation, non-strict boolean decoding, partial selector matching, or unchecked slice operations on untrusted payloads
- Counter-evidence: explicit length checks before deserialization, strict boolean validation (reject reserved bits), full-width selector comparison, bounds-checked slicing

## SOL-R015

- Title: Event/log emits untrusted instruction parameters
- Severity default: Low
- Trigger idea: emitted event fields sourced from instruction parameters rather than validated on-chain account state; off-chain indexers/relayers trust event data
- Counter-evidence: all event fields read from on-chain account state (e.g., `ctx.accounts.pda.field`), or instruction parameters validated against stored state before emission
