# CAT-II Account Validation Category

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

