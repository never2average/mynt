# CAT-XIV Data Encoding / Decoding Security Category

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

