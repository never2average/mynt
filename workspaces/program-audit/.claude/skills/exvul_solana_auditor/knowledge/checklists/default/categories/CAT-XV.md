# CAT-XV Cross-Chain / Bridge-Specific Security Category

### 1. Trusted Chain / Address Validation
    Description: The program does not validate that newly added trusted chains or addresses do not conflict with reserved or internal identifiers (e.g., adding the hub chain itself as a trusted chain). This can create circular trust relationships or routing loops in cross-chain message passing.
    Remediation: Validate new trusted chain names and addresses against reserved identifiers and existing entries; reject self-referential or duplicate entries.

### 2. Inconsistent State Update Guards
    Description: State-modifying instructions do not check whether the new value differs from the current stored value before executing the update. No-op updates waste compute, emit misleading events, and can mask logical errors in governance or configuration workflows.
    Remediation: Add pre-condition checks to verify the new value differs from the current one (e.g., `require!(new_value != current_value)`); skip serialization and event emission for no-op updates.
