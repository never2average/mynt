# CAT-VI Account Initialization and Closure Category

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

