# Default Checklist Index (Lite)

Use this index for low-token checklist planning.
Load category detail files lazily only when needed.

## Categories

| Category ID | Title | Item Count | File |
|---|---|---:|---|
| CAT-I | Access Control Category | 5 | CAT-I.md |
| CAT-II | Account Validation Category | 13 | CAT-II.md |
| CAT-III | Arithmetic and Computational Security Category | 9 | CAT-III.md |
| CAT-IV | CPI (Cross Program Invocation) Related | 6 | CAT-IV.md |
| CAT-V | PDA (Program-Derived Address) Related | 6 | CAT-V.md |
| CAT-VI | Account Initialization and Closure Category | 4 | CAT-VI.md |
| CAT-VII | Duplication and Conflict Category | 1 | CAT-VII.md |
| CAT-VIII | Error Handling and Stability Category | 3 | CAT-VIII.md |
| CAT-IX | Randomness and Oracle Category | 2 | CAT-IX.md |
| CAT-X | Performance and DoS Category | 2 | CAT-X.md |
| CAT-XI | Testing and Deployment Category | 1 | CAT-XI.md |
| CAT-XII | Token-2022 / Token Extensions Category | 7 | CAT-XII.md |
| CAT-XIII | Transaction-Level Security Category | 2 | CAT-XIII.md |
| CAT-XIV | Data Encoding / Decoding Security Category | 4 | CAT-XIV.md |
| CAT-XV | Cross-Chain / Bridge-Specific Security Category | 2 | CAT-XV.md |

## Items

Per-item fields are intentionally minimal for token efficiency.

### CAT-I
- `CL-I-01` | Missing Signer Check/Verification
- `CL-I-02` | Missing Ownership/Owner Check
- `CL-I-03` | Weak Access Control
- `CL-I-04` | Authority Transfer Limitation
- `CL-I-05` | Missing Writable Account Check

### CAT-II
- `CL-II-01` | Account Type Confusion / Type Cosplay
- `CL-II-02` | Invalid Account Relationship
- `CL-II-03` | Account Data Mismatch
- `CL-II-04` | Unchecked Account Inputs
- `CL-II-05` | Remaining Accounts Injection
- `CL-II-06` | Fake Sysvar Account / Sysvar Address Spoofing
- `CL-II-07` | Account Revival Attack
- `CL-II-08` | Missing Account Initialization Check
- `CL-II-09` | Improper Account Data Validation
- `CL-II-10` | Account Data Matching
- `CL-II-11` | Unsafe Account Reallocation
- `CL-II-12` | Missing System Account / Program ID Check
- `CL-II-13` | Orphan Account from Parent-Child Lifecycle Dependency

### CAT-III
- `CL-III-01` | Integer Overflow / Underflow
- `CL-III-02` | Rounding / Precision Errors / Precision Loss
- `CL-III-03` | Casting Truncation
- `CL-III-04` | Signed-to-Unsigned Casting
- `CL-III-05` | Inaccurate Calculation with Saturating Math
- `CL-III-06` | Division by Zero Panic
- `CL-III-07` | Incorrect Calculation
- `CL-III-08` | Multiplication After Division Precision Loss
- `CL-III-09` | Custom Type Ordering / Trait Derivation Bug

### CAT-IV
- `CL-IV-01` | Arbitrary CPI / Arbitrary Program Invocation
- `CL-IV-02` | CPI Privilege Escalation
- `CL-IV-03` | Reentrancy Through CPI
- `CL-IV-04` | Stale Account State / Account Reloading
- `CL-IV-05` | CPI Signer Privilege Forwarding
- `CL-IV-06` | Account Ownership Reassignment via CPI

### CAT-V
- `CL-V-01` | Non-Canonical PDA Bump
- `CL-V-02` | PDA Privilege Misuse
- `CL-V-03` | PDA Sharing
- `CL-V-04` | PDA Seed Collision
- `CL-V-05` | PDA Substitution
- `CL-V-06` | PDA Signer Without Account Isolation

### CAT-VI
- `CL-VI-01` | Re-initialization Vulnerability / Account Reinitialization
- `CL-VI-02` | Initialization Front-Running / Insecure Initialization
- `CL-VI-03` | Improper Account Closure
- `CL-VI-04` | Missing Initialization Guard

### CAT-VII
- `CL-VII-01` | Duplicate Mutable Accounts

### CAT-VIII
- `CL-VIII-01` | Error Not Handled / Unhandled Errors
- `CL-VIII-02` | Panic / Error Handling Issues
- `CL-VIII-03` | Unsafe Rust Usage

### CAT-IX
- `CL-IX-01` | Insecure Randomness
- `CL-IX-02` | Oracle Manipulation

### CAT-X
- `CL-X-01` | Unbounded Loop / Compute Exhaustion / Exponential Complexity
- `CL-X-02` | Lamport Transfer to Unvalidated Account

### CAT-XI
- `CL-XI-01` | Lack of Security Testing

### CAT-XII
- `CL-XII-01` | Transfer Fee Bypass via Mint Reinitialization
- `CL-XII-02` | Permanent Delegate Fund Drain Risk
- `CL-XII-03` | Transfer Hook Verification Missing
- `CL-XII-04` | Default Frozen Account State
- `CL-XII-05` | Mint Close and Reinitialize Risks
- `CL-XII-06` | Dynamic Token Account Size
- `CL-XII-07` | CPI Guard Interaction

### CAT-XIII
- `CL-XIII-01` | Frontrunning / Transaction Ordering Manipulation
- `CL-XIII-02` | Timely State Reset

### CAT-XIV
- `CL-XIV-01` | Missing Input Length Validation Before Deserialization
- `CL-XIV-02` | Non-Strict Boolean / Flag Decoding
- `CL-XIV-03` | Partial Selector / Discriminator Matching
- `CL-XIV-04` | Event / Log Data Integrity

### CAT-XV
- `CL-XV-01` | Trusted Chain / Address Validation
- `CL-XV-02` | Inconsistent State Update Guards

