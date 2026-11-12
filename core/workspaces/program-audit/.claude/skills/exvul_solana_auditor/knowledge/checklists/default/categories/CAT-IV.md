# CAT-IV CPI (Cross Program Invocation) Related

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

