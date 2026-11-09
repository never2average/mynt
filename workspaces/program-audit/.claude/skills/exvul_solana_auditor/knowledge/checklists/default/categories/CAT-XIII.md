# CAT-XIII Transaction-Level Security Category

### 1. Frontrunning / Transaction Ordering Manipulation
    Description: Attackers can observe pending transactions and submit their own transactions with higher priority to manipulate on-chain state before the victim's transaction executes. Common targets include: changing listing prices before purchases, initializing accounts before legitimate deployers, and manipulating oracle prices before dependent transactions.
    Remediation: Include expected-value checks in instructions (e.g., `expected_price`, `min_amount_out`); use slippage protection; restrict initialization to upgrade authority; design programs to be order-independent where possible.

### 2. Timely State Reset
    Description: The program does not reset intermediate state variables after an operation completes, allowing subsequent calls to operate on stale or leftover state from previous operations. This can lead to incorrect calculations, double-spending, or permission leakage.
    Remediation: Reset all intermediate state variables at the beginning or end of each operation; validate state freshness before use; use per-operation nonces or timestamps to detect stale state.

