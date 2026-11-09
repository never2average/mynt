# CAT-III Arithmetic and Computational Security Category

### 1. Integer Overflow / Underflow
    Description: Raw `+ - * /` operators are used for arithmetic operations without boundary checks; Rust will silently wrap values in Release mode, leading to incorrect balances or state corruption.
    Remediation: Use safe arithmetic methods such as `checked_add`, `checked_sub`, `checked_mul`, or explicitly validate value ranges.

### 2. Rounding / Precision Errors / Precision Loss
    Description: Unsafe rounding methods (e.g., `try_round_u64`), floating-point operations or saturating math functions are used in financial calculations, leading to precision loss, value leakage or arbitrage opportunities.
    Remediation: Use deterministic rounding strategies (e.g., fixed `floor`/`ceil`) and fixed-point arithmetic; replace saturating math functions with checked arithmetic with explicit validation.

### 3. Casting Truncation
    Description: Numeric type casting (e.g., `u64 -> u32`) truncates high-order bits, leading to incorrect balances or logic bypass.
    Remediation: Validate numeric ranges before casting, or use numeric types with sufficient bit width.

### 4. Signed-to-Unsigned Casting
    Description: Casting signed integers to unsigned types (e.g., `i64 as u64` for timestamps) without validation can produce incorrect values when the signed value is negative. On Solana, `Clock::get()?.unix_timestamp` returns `i64` which is commonly unsafely cast to `u64`.
    Remediation: Use `u64::try_from()` with explicit error handling instead of `as` casts; validate that signed values are non-negative before conversion.

### 4. Inaccurate Calculation with Saturating Math
    Description: `saturating_add`/`saturating_sub`/`saturating_mul` are used without verifying logical assumptions, resulting in incorrect results.
    Remediation: Replace with checked arithmetic operations and add explicit logical validation.

### 5. Division by Zero Panic
    Description: The divisor is not validated for zero before division operations, causing program panic and transaction failure.
    Remediation: Validate that the divisor is non-zero before division, and handle zero-value scenarios explicitly.

### 6. Incorrect Calculation
    Description: Errors in financial calculation logic (e.g., inconsistent rounding rules, incorrect formulas) lead to value leakage or manipulation.
    Remediation: Implement deterministic rounding rules, validate arithmetic invariants, and audit core calculation logic.

### 7. Multiplication After Division Precision Loss
    Description: Performing division before multiplication in fixed-point arithmetic causes premature rounding, producing smaller results than expected. The expression `(a / c) * b` loses precision compared to `(a * b) / c` because the intermediate quotient is rounded down before multiplication.
    Remediation: Always multiply before dividing in financial calculations; use high-precision intermediate representations to minimize rounding errors.

### 8. Custom Type Ordering / Trait Derivation Bug
    Description: Deriving standard traits (e.g., `Ord`, `PartialOrd`, `Eq`) on custom numeric types with non-standard internal representations (e.g., little-endian limb arrays for U256) produces incorrect comparison behavior. For example, a little-endian U256 with derived `Ord` compares limbs lexicographically starting from the least significant, causing comparison guards (like underflow checks in `checked_sub`) to fail.
    Remediation: Implement `Ord`/`PartialOrd` manually for custom numeric types to match their semantic ordering; add comprehensive test cases covering edge cases around comparison boundaries.

