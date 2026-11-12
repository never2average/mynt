# CAT-I Access Control Category

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

