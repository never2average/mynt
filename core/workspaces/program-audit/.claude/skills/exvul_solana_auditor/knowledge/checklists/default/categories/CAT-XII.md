# CAT-XII Token-2022 / Token Extensions Category

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

