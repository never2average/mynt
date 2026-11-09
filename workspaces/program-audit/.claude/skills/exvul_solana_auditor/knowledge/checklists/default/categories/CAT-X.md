# CAT-X Performance and DoS Category

### 1. Unbounded Loop / Compute Exhaustion / Exponential Complexity
    Description: The number of loop iterations grows exponentially with user input. Attackers can exhaust compute resources with overly large inputs to trigger a DoS attack.
    Remediation: Limit the number of loop iterations and the length of user input arrays, and enforce strict boundary checks.

### 2. Lamport Transfer to Unvalidated Account
    Description: Transferring lamports to an arbitrary account can fail silently or brick the program due to: (a) the recipient not meeting rent-exemption thresholds, (b) the recipient being an executable account (which rejects lamport changes), or (c) the recipient being a reserved account that is write-demoted by the runtime. These edge cases can permanently lock funds or prevent program progression.
    Remediation: Before transferring lamports, verify that the recipient is not executable, that the post-transfer balance meets rent-exemption, and that the recipient is not a reserved/write-demoted account; prefer transferring to program-owned PDA vaults rather than arbitrary accounts.

