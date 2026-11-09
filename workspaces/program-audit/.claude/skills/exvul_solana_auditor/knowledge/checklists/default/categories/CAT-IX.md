# CAT-IX Randomness and Oracle Category

### 1. Insecure Randomness
    Description: On-chain predictable values (slots, timestamps, blockhashes) are used as randomness. Attackers can simulate outcomes and submit only favorable transactions.
    Remediation: Use verifiable random number schemes such as VRF and commit-reveal.

### 2. Oracle Manipulation
    Description: The program trusts a single oracle source or does not validate the validity of price feeds, allowing attackers to manipulate the source market to tamper with data.
    Remediation: Use trusted oracle programs, and validate oracle accounts and data freshness (e.g., Pyth's `PriceStatus::Trading`).

