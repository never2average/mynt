# CAT-V PDA (Program-Derived Address) Related

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

