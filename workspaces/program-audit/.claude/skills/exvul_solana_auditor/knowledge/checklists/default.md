# EXVULSEC Solana Security Checklist

Use this checklist as the default coverage baseline for every full-run audit.
Prefer using `knowledge/checklists/default/index.md` for index-first low-token planning.
Use this file as a legacy fallback or for full-detail reference only.

## I. Access Control Category
### 1. Missing Signer Check/Verification
    Description: The program does not verify the `is_signer` attribute of an account when executing privileged logic, only checking the existence of the public key without validating signing permissions. Attackers can pass the public key of a privileged account (without holding the private key) to perform sensitive operations and bypass authorization restrictions.
    Remediation: Explicitly mark privileged accounts as `Signer<'info>` (Anchor), or manually verify the signer's identity via `require!(account.is_signer)`.

### 2. Missing Ownership/Owner Check
    Description: The program does not verify `account.owner` before reading/modifying account data. Attackers can pass malicious accounts owned by other programs with identical layouts to tamper with the state that should be protected.
    Remediation: Explicitly verify that `account.owner == expected program ID`; use Anchor's `#[account(owner = ...)]` constraint or manually validate ownership.

### 3. Weak Access Control
    Description: Admin or privileged functions lack strict permission checks, allowing unauthorized users to modify parameters or perform restricted actions.
    Remediation: Implement explicit permission check logic, and restrict the call scope of admin functions through `has_one`, `constraint` or dedicated privilege accounts.

### 4. Authority Transfer Limitation
    Description: The program hardcodes admin authority to a static account with no authority transfer mechanism; if the private key is compromised or lost, the program control cannot be migrated securely.
    Remediation: Implement an authority transfer function with complete authorization checks to ensure that authority changes are traceable and verifiable.

### 5. Missing Writable Account Check
    Description: The program does not verify `is_writable` before modifying account state, which may lead to abnormal behavior or exploitable vulnerability conditions.
    Remediation: Explicitly validate `account.is_writable` before modifying account data.

## II. Account Validation Category
### 1. Account Type Confusion / Type Cosplay
    Description: The program does not verify the discriminator or struct layout of an account. Attackers can pass accounts of other types with similar field offsets to bypass logic checks.
    Remediation: Use typed accounts (e.g., Anchor `Account<T>`), and verify the account discriminator and ownership before deserialization.

### 2. Invalid Account Relationship
    Description: The program only verifies the account type but not the contextual relational constraints (e.g., mint/owner of a token account), allowing attackers to replace compatible accounts under their control.
    Remediation: Validate relational constraints between accounts (e.g., `token_account.mint == expected_mint`, `token_account.owner == user.key()`).

### 3. Account Data Mismatch
    Description: The program does not verify that account data is consistent with expected values (e.g., admin key in a config account). Attackers can replace accounts with malicious fields to bypass permission checks.
    Remediation: Validate that account fields (e.g., admin key, state flags) match the expected values before executing privileged logic.

### 4. Unchecked Account Inputs
    Description: The program directly uses `AccountInfo`/`UncheckedAccount` without verifying ownership, data layout or inter-account relationships, allowing attackers to substitute malicious accounts.
    Remediation: Manually validate all unchecked accounts or replace them with typed accounts; use Anchor constraints whenever possible.

### 5. Remaining Accounts Injection
    Description: The program does not validate accounts in `ctx.remaining_accounts`, allowing attackers to inject malicious accounts to trigger unintended logic.
    Remediation: Explicitly verify the ownership, type and relational constraints of each account in `remaining_accounts`.

### 6. Fake Sysvar Account / Sysvar Address Spoofing
    Description: The program does not verify that the account is the official canonical address before reading Sysvar data. Attackers can pass fake Sysvar accounts to provide false data.
    Remediation: Validate that the Sysvar account address is consistent with the canonical ID known by the system (e.g., `sysvar::rent::ID`).

### 7. Account Revival Attack
    Description: The program reuses closed accounts without validation. Attackers can re-fund the accounts to restore the stale state of previously closed accounts.
    Remediation: Zero out account data when closing an account, and verify the account's lamports and data state before reuse; use the Anchor `close` constraint.

### 8. Missing Account Initialization Check
    Description: The initialization logic does not verify whether an account has been initialized. Attackers can repeatedly call the initialization instruction to overwrite permissions/state.
    Remediation: Use an initialization flag or the Anchor `init` constraint to ensure an account can only be initialized once.

### 9. Improper Account Data Validation
    Description: The program trusts account data without validating expected fields, initialization state or invariants, leading to the exploitation of malicious data.
    Remediation: Validate account state fields, initialization flags and structural invariants before executing logic.

### 10. Account Data Matching
    Description: The program only verifies the consistency of the account address but not the actual data/state within the account. Attackers can pass accounts with a valid address but tampered fields.
    Remediation: Verify both the account address and internal fields (e.g., authority, mint, state flags) simultaneously.

### 11. Unsafe Account Reallocation
    Description: Improper use of Anchor `realloc` may expose stale data or cause compute inefficiencies.
    Remediation: Configure the correct `zero_init` parameter when using `realloc`, and calculate the data size accurately.

### 12. Missing System Account / Program ID Check
    Description: The program does not verify that system accounts (e.g., System Program, Token Program, Rent Sysvar) match their canonical addresses. Attackers can substitute fake system program accounts to bypass intended logic.
    Remediation: Validate system account addresses against canonical IDs (e.g., `system_program::ID`, `spl_token::ID`); use Anchor typed `Program<'info, T>` accounts.

### 13. Orphan Account from Parent-Child Lifecycle Dependency
    Description: PDA accounts with parent-child relationships (e.g., a proposal PDA and its associated operator PDA) can become orphaned when the parent is closed without first closing or validating the child. The orphaned child account becomes permanently uncloseable because its validation depends on the now-destroyed parent account.
    Remediation: Enforce parent-child lifecycle invariants: either close child accounts before closing the parent, or decouple child validation from parent account existence; add checks to prevent closing a parent account that still has active children.

## III. Arithmetic and Computational Security Category
### 1. Integer Overflow / Underflow
    Description: Raw `+ - * /` operators are used for arithmetic operations without boundary checks; Rust will silently wrap values in Release mode, leading to incorrect balances or state corruption.
    Remediation: Use safe arithmetic methods such as `checked_add`, `checked_sub`, `checked_mul`, or explicitly validate value ranges.

### 2. Rounding / Precision Errors / Precision Loss
    Description: Unsafe rounding methods (e.g., `try_round_u64`), floating-point operations or saturating math functions are used in financial calculations, leading to precision loss, value leakage or arbitrage opportunities.
    Remediation: Use deterministic rounding strategies (e.g., fixed `floor`/`ceil`) and fixed-point arithmetic; replace saturating math functions with checked arithmetic with explicit validation.

### 3. Casting Truncation
    Description: Numeric type casting (e.g., `u64 -> u32`) truncates high-order bits, leading to incorrect balances or logic bypass.
    Remediation: Validate numeric ranges before casting, or use numeric types with sufficient bit width.

### 4. Signed-to-Unsigned Casting
    Description: Casting signed integers to unsigned types (e.g., `i64 as u64` for timestamps) without validation can produce incorrect values when the signed value is negative. On Solana, `Clock::get()?.unix_timestamp` returns `i64` which is commonly unsafely cast to `u64`.
    Remediation: Use `u64::try_from()` with explicit error handling instead of `as` casts; validate that signed values are non-negative before conversion.

### 4. Inaccurate Calculation with Saturating Math
    Description: `saturating_add`/`saturating_sub`/`saturating_mul` are used without verifying logical assumptions, resulting in incorrect results.
    Remediation: Replace with checked arithmetic operations and add explicit logical validation.

### 5. Division by Zero Panic
    Description: The divisor is not validated for zero before division operations, causing program panic and transaction failure.
    Remediation: Validate that the divisor is non-zero before division, and handle zero-value scenarios explicitly.

### 6. Incorrect Calculation
    Description: Errors in financial calculation logic (e.g., inconsistent rounding rules, incorrect formulas) lead to value leakage or manipulation.
    Remediation: Implement deterministic rounding rules, validate arithmetic invariants, and audit core calculation logic.

### 7. Multiplication After Division Precision Loss
    Description: Performing division before multiplication in fixed-point arithmetic causes premature rounding, producing smaller results than expected. The expression `(a / c) * b` loses precision compared to `(a * b) / c` because the intermediate quotient is rounded down before multiplication.
    Remediation: Always multiply before dividing in financial calculations; use high-precision intermediate representations to minimize rounding errors.

### 8. Custom Type Ordering / Trait Derivation Bug
    Description: Deriving standard traits (e.g., `Ord`, `PartialOrd`, `Eq`) on custom numeric types with non-standard internal representations (e.g., little-endian limb arrays for U256) produces incorrect comparison behavior. For example, a little-endian U256 with derived `Ord` compares limbs lexicographically starting from the least significant, causing comparison guards (like underflow checks in `checked_sub`) to fail.
    Remediation: Implement `Ord`/`PartialOrd` manually for custom numeric types to match their semantic ordering; add comprehensive test cases covering edge cases around comparison boundaries.

## IV. CPI (Cross Program Invocation) Related
### 1. Arbitrary CPI / Arbitrary Program Invocation
    Description: The CPI target program is user-supplied and not validated. Attackers can redirect the invocation to a malicious program to execute unintended logic with the current program's authority.
    Remediation: Validate that the CPI's `program_id` is consistent with the expected address before invocation; use typed program accounts (e.g., `Program<'info, Token>`).

### 2. CPI Privilege Escalation
    Description: The program unintentionally forwards signer/writable privileges through CPI, allowing downstream programs to perform privileged operations using these permissions.
    Remediation: Restrict CPI accounts to the minimum required privileges; carefully validate the seeds for `invoke_signed`.

### 3. Reentrancy Through CPI
    Description: Improper state management allows recursive/nested CPI calls to manipulate the program state unexpectedly.
    Remediation: Update critical state before external calls, and re-validate state consistency after CPI.

### 4. Stale Account State / Account Reloading
    Description: The program continues to use cached account state after CPI without refreshing the data, leading to incorrect logic execution based on stale state.
    Remediation: Explicitly reload/deserialize the account (e.g., `account.reload()?`) after CPI before executing logic that depends on the state.

### 5. CPI Signer Privilege Forwarding
    Description: Once an account signs an instruction, its signer privilege is retained through the entire CPI chain. A malicious downstream program can abuse forwarded signer privileges to transfer SOL, steal tokens, or invoke other programs on behalf of the signer.
    Remediation: For arbitrary CPI scenarios, verify that accounts passed to CPIs do not carry unnecessary signer flags; check account balances and ownership before and after CPI to detect unauthorized transfers or ownership changes.

### 6. Account Ownership Reassignment via CPI
    Description: A malicious program invoked via CPI can use the `system_instruction::assign` instruction to change the owner of a signed account. The attacker gains full control of the account and can drain its lamports in a subsequent transaction.
    Remediation: After any CPI to an untrusted program, verify that `account.owner` is still `system_program::ID`; avoid passing signer-privileged accounts into arbitrary CPIs.

## V. PDA (Program-Derived Address) Related
### 1. Non-Canonical PDA Bump
    Description: The program accepts any valid PDA bump value instead of enforcing the canonical bump; attackers can create alternative PDAs with the same seeds but different bumps.
    Remediation: Derive PDAs via `find_program_address` and enforce the use of canonical bump values.

### 2. PDA Privilege Misuse
    Description: A PDA is used as a privileged account without verifying the correctness of its seeds and bump, allowing attackers to forge equivalent addresses.
    Remediation: Derive PDAs with deterministic seeds, and verify the bump and seeds using `Pubkey::find_program_address`.

### 3. PDA Sharing
    Description: The same PDA seeds are reused across multiple authority domains/roles, leading to permission overlap and unintended access.
    Remediation: Derive separate PDAs with distinct seeds for different roles/functions (e.g., `[b"pool", user.key()]`).

### 4. PDA Seed Collision
    Description: Poor seed design leads to PDA address collisions or predictability, allowing attackers to deploy malicious accounts in advance.
    Remediation: Use unique prefixes and user-specific data in seeds to avoid address collisions.

### 5. PDA Substitution
    Description: The program accepts PDA accounts without verifying the derived seeds and bump, allowing attackers to substitute malicious PDAs.
    Remediation: Validate PDAs via `find_program_address` and enforce the use of canonical seeds and bumps.

### 6. PDA Signer Without Account Isolation
    Description: A PDA used as a signer in CPI is derived with generic seeds (e.g., `[b"authority"]`) rather than user-scoped seeds. Any CPI receiver can reuse the PDA signer privilege across all users, escalating a single-user exploit to protocol-wide impact.
    Remediation: Include user-specific data in PDA seeds (e.g., `[b"authority", user.key()]`) to isolate signer scope per user; follow the principle of one-account-one-permission.

## VI. Account Initialization and Closure Category
### 1. Re-initialization Vulnerability / Account Reinitialization
    Description: The initialization instruction can be executed repeatedly on an already initialized account, allowing attackers to overwrite permissions or state.
    Remediation: Validate the initialization flag, or use the Anchor `init` constraint (which fails if the account already exists).

### 2. Initialization Front-Running / Insecure Initialization
    Description: The initialization instruction lacks authority binding. Attackers can front-run to initialize accounts and usurp the authority for themselves.
    Remediation: Restrict initialization to upgrade authority accounts or verified admin signers; use predefined PDA seeds to bind initialization permissions.

### 3. Improper Account Closure
    Description: Account closure only transfers lamports but does not zero out data, allowing attackers to re-fund the account to restore its state.
    Remediation: Zero out account data and mark the account as invalid when closing; use the Anchor `close` constraint.

### 4. Missing Initialization Guard
    Description: The initialization instruction can be called multiple times, allowing attackers to overwrite account state/permissions.
    Remediation: Prevent re-initialization via an initialization flag or the Anchor `init` constraint.

## VII. Duplication and Conflict Category
### 1. Duplicate Mutable Accounts
    Description: The same account is passed multiple times as a mutable parameter, breaking logical assumptions (e.g., the same account as both the source and destination of a transfer) and leading to unintended state manipulation.
    Remediation: Validate the uniqueness of mutable accounts (e.g., `account_a.key() != account_b.key()`).

## VIII. Error Handling and Stability Category
### 1. Error Not Handled / Unhandled Errors
    Description: The return value is not checked when calling functions that return a `Result`, and errors propagate silently leading to inconsistent state.
    Remediation: Use `?` or explicit error handling to catch all return values of the `Result` type.

### 2. Panic / Error Handling Issues
    Description: Operations that are prone to panics (e.g., `unwrap()`, division by zero) are used, causing unexpected program termination and transaction failure.
    Remediation: Use `Result`/`Option` to handle potential errors, and validate inputs before performing risky operations.

### 3. Unsafe Rust Usage
    Description: `unsafe` code blocks bypass memory safety guarantees, which may lead to memory corruption or undefined behavior.
    Remediation: Minimize `unsafe` code, and add strict validation and documentation when encapsulating it.

## IX. Randomness and Oracle Category
### 1. Insecure Randomness
    Description: On-chain predictable values (slots, timestamps, blockhashes) are used as randomness. Attackers can simulate outcomes and submit only favorable transactions.
    Remediation: Use verifiable random number schemes such as VRF and commit-reveal.

### 2. Oracle Manipulation
    Description: The program trusts a single oracle source or does not validate the validity of price feeds, allowing attackers to manipulate the source market to tamper with data.
    Remediation: Use trusted oracle programs, and validate oracle accounts and data freshness (e.g., Pyth's `PriceStatus::Trading`).

## X. Performance and DoS Category
### 1. Unbounded Loop / Compute Exhaustion / Exponential Complexity
    Description: The number of loop iterations grows exponentially with user input. Attackers can exhaust compute resources with overly large inputs to trigger a DoS attack.
    Remediation: Limit the number of loop iterations and the length of user input arrays, and enforce strict boundary checks.

### 2. Lamport Transfer to Unvalidated Account
    Description: Transferring lamports to an arbitrary account can fail silently or brick the program due to: (a) the recipient not meeting rent-exemption thresholds, (b) the recipient being an executable account (which rejects lamport changes), or (c) the recipient being a reserved account that is write-demoted by the runtime. These edge cases can permanently lock funds or prevent program progression.
    Remediation: Before transferring lamports, verify that the recipient is not executable, that the post-transfer balance meets rent-exemption, and that the recipient is not a reserved/write-demoted account; prefer transferring to program-owned PDA vaults rather than arbitrary accounts.

## XI. Testing and Deployment Category
### 1. Lack of Security Testing
    Description: The program is deployed without proper security testing, fuzzing or static analysis, leaving undiscovered vulnerabilities.
    Remediation: Integrate security checks into the CI/CD pipeline (e.g., `cargo audit`, `anchor test`, static analysis tools).

## XII. Token-2022 / Token Extensions Category
### 1. Transfer Fee Bypass via Mint Reinitialization
    Description: A malicious mint creator can create a mint without extensions, allow users to create token accounts, then close and reinitialize the mint with a transfer fee. Token accounts created before the extension was added can transfer tokens without paying fees using the original `transfer` instruction, while legitimate users must pay.
    Remediation: Verify that supported mints have not been reinitialized; check that the Mint Close Authority extension was never present (even on mints currently without it); do not trust mint extension state alone.

### 2. Permanent Delegate Fund Drain Risk
    Description: Token-2022 mints with a Permanent Delegate authority grant unlimited access to transfer or burn tokens from any token account. A malicious or compromised delegate can drain vault accounts holding multiple users' deposits.
    Remediation: Verify the presence and trust of the permanent delegate authority before accepting a token mint; use isolated per-user token accounts instead of shared vaults when supporting mints with permanent delegates.

### 3. Transfer Hook Verification Missing
    Description: Token-2022 transfer hooks execute custom logic on every transfer but can be called by any mint. If the hook program does not verify the calling mint or check the `transferring` flag, attackers can invoke the hook outside of legitimate transfers or with unauthorized mints to manipulate hook-owned state.
    Remediation: In transfer hook programs, verify that source/destination token account mints match expected mints; check that the `transferring` flag is set on involved token accounts; scope PDA seeds by mint key.

### 4. Default Frozen Account State
    Description: Token-2022 mints with the Default Account State extension can freeze all new token accounts on creation. Programs that create vault or escrow token accounts for such mints will silently fail when attempting transfers.
    Remediation: Check the default account state of mints before creating token accounts; handle frozen account states in program logic; thaw accounts if the program holds freeze authority.

### 5. Mint Close and Reinitialize Risks
    Description: The Mint Close Authority extension allows mints to be closed (when supply is 0) and reinitialized at the same address with different extensions. Orphaned token accounts from the original mint become associated with the new mint, leading to extension incompatibilities (e.g., bypassing soulbound/non-transferable restrictions or KYC-freeze requirements).
    Remediation: Verify mint initialization history; check that mint extensions match expected configuration; do not trust orphaned token accounts from previously closed mints.

### 6. Dynamic Token Account Size
    Description: Token-2022 token accounts can vary in size depending on the extensions enabled, and can grow via `Reallocate`. Hardcoding a fixed account size or rent amount causes account creation failures when extensions require more space.
    Remediation: Use `getExtensionTypes` and `getMinimumBalanceForRentExemptAccountWithExtensions` to dynamically calculate account size and rent; never hardcode token account sizes or rent amounts.

### 7. CPI Guard Interaction
    Description: Token accounts with the CPI Guard extension enabled reject token transfers initiated via CPI, except through the delegation flow. Programs that perform direct CPI token transfers will fail when interacting with CPI Guard-protected accounts.
    Remediation: Detect CPI Guard status on token accounts; use the approve-then-transfer delegation flow when CPI Guard is active; handle CPI Guard-related errors gracefully.

## XIII. Transaction-Level Security Category
### 1. Frontrunning / Transaction Ordering Manipulation
    Description: Attackers can observe pending transactions and submit their own transactions with higher priority to manipulate on-chain state before the victim's transaction executes. Common targets include: changing listing prices before purchases, initializing accounts before legitimate deployers, and manipulating oracle prices before dependent transactions.
    Remediation: Include expected-value checks in instructions (e.g., `expected_price`, `min_amount_out`); use slippage protection; restrict initialization to upgrade authority; design programs to be order-independent where possible.

### 2. Timely State Reset
    Description: The program does not reset intermediate state variables after an operation completes, allowing subsequent calls to operate on stale or leftover state from previous operations. This can lead to incorrect calculations, double-spending, or permission leakage.
    Remediation: Reset all intermediate state variables at the beginning or end of each operation; validate state freshness before use; use per-operation nonces or timestamps to detect stale state.

## XIV. Data Encoding / Decoding Security Category
### 1. Missing Input Length Validation Before Deserialization
    Description: The program deserializes ABI-encoded, Borsh-encoded, or raw byte payloads without first checking that the input length meets the minimum required size. Malformed or extremely large inputs force the decoder to allocate and parse before failing, wasting compute units or causing panics on out-of-bounds slicing.
    Remediation: Validate `data.len()` against the minimum expected size before any deserialization or slicing; return early with a descriptive error on insufficient length.

### 2. Non-Strict Boolean / Flag Decoding
    Description: The program's manual decoder accepts any byte value for boolean fields (e.g., `is_signer`, `is_writable`) instead of enforcing strict encoding (only `0` or `1`). Values like `0xFF` with the correct low bit set bypass validation, enabling injection of invalid metadata. Debug and release builds may behave differently if debug uses a strict library decoder while release uses the manual one.
    Remediation: Validate that boolean/flag bytes contain only expected values (e.g., reject if reserved bits are set); ensure debug and release builds use the same validation logic.

### 3. Partial Selector / Discriminator Matching
    Description: The program matches message type selectors or account discriminators by checking only a subset of the value (e.g., only the least-significant byte of a 256-bit selector). Any value with the correct low byte but arbitrary high bits is accepted, enabling type confusion or unintended instruction routing.
    Remediation: Compare the full width of selectors and discriminators; reject values with non-zero bits outside the expected range.

### 4. Event / Log Data Integrity
    Description: The program emits events or logs using untrusted instruction parameters (passed by the caller) instead of values stored in validated on-chain accounts. Attackers can supply arbitrary data to falsify event records, misleading off-chain indexers, explorers, and relayers that depend on event accuracy.
    Remediation: Always emit event data from on-chain account state (e.g., `ctx.accounts.proposal_pda.eta`) rather than instruction parameters; validate any user-supplied values against stored state before including them in events.

## XV. Cross-Chain / Bridge-Specific Security Category
### 1. Trusted Chain / Address Validation
    Description: The program does not validate that newly added trusted chains or addresses do not conflict with reserved or internal identifiers (e.g., adding the hub chain itself as a trusted chain). This can create circular trust relationships or routing loops in cross-chain message passing.
    Remediation: Validate new trusted chain names and addresses against reserved identifiers and existing entries; reject self-referential or duplicate entries.

### 2. Inconsistent State Update Guards
    Description: State-modifying instructions do not check whether the new value differs from the current stored value before executing the update. No-op updates waste compute, emit misleading events, and can mask logical errors in governance or configuration workflows.
    Remediation: Add pre-condition checks to verify the new value differs from the current one (e.g., `require!(new_value != current_value)`); skip serialization and event emission for no-op updates.
