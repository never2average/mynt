---
name: financial-modelling
description: What a good feasibility model covers for each product line (credit, securitization, payments, account operations, custody and settlement, wealth, insurance, guarantees and trade, exchange, derivatives, information), with stress scenarios and regulatory checks.
---

# What a good model covers

Always include:
- **Stress scenarios:** e.g. the default rate doubled, rates moved ±200bp, faster prepayment, a lapse shock,
  falling AUM.
- **A check per applicable regulatory limit**, citing its `legal_ref` from the spec. If the limit's number isn't
  in the spec, say so in the check; never invent it.
- **Stated assumptions:** every assumption, with where it came from (the term sheet, an industry benchmark you
  name, or your judgement, flagged as such).

Lines are by economic function. A product made of several primitives (say, a cross-border transfer: an
exchange primitive plus a payments primitive) needs the cover for each line it touches.

| Line | Cover |
|---|---|
| **Credit** (loans) | Pricing build-up: cost of funds, expected loss (PD × LGD), operating costs, capital charge (risk weight × capital ratio × cost of equity), margin. APR including fees, and EMI. Return on risk-adjusted capital (RAROC). Cohort cash flows and breakeven. |
| **Credit** (bonds, T-bills, commercial paper) | Spread over the benchmark, duration and convexity, and how the value moves when rates move. Credit-rating migration and default loss. Liquidity and counterparty limits. |
| **Securitization** | Pool cash flows under default, prepayment and recovery assumptions. The tranche waterfall, credit enhancement and the first-loss piece retained. Servicing fees. Minimum holding and retention rules. |
| **Payments** | Revenue per transaction against interchange, scheme and network fees. Fraud and chargeback losses. Settlement float and the cost of pre-funding. Volume needed to cover fixed costs. |
| **Account operations** (deposits) | Margin against where the money is deployed. Liquidity ladder by tenor. Reserve-requirement drag (CRR/SLR, where it applies). Deposit-insurance premium. The cost of the early-withdrawal penalty. |
| **Custody and settlement** | Fee income in basis points of assets held, and per transaction. Operational-loss and reconciliation-break costs. Capital and insurance for assets in custody. Settlement-failure exposure. |
| **Wealth** | Fee income against expense-ratio (TER) and commission caps. Distribution trail. The AUM at which the product breaks even, and the time to reach it. Under a wrapper (pension, tax-advantaged, government scheme), its contribution, lock-in and withdrawal rules. |
| **Insurance** | Expected claims (frequency × severity, or mortality/morbidity tables you name). Loss ratio and combined ratio. Commission caps. Reserving, and the solvency margin. |
| **Guarantees and trade** | Fee against the expected loss on invocation. Capital charge on the contingent exposure. For factoring and supply-chain finance, the dilution and buyer-default rates and the days the money is out. |
| **Exchange** | Spread or commission per trade against execution, clearing and market-data costs. Inventory and price risk on held positions. Volume needed to break even. |
| **Derivatives** | Margin and collateral calls under the stress moves. Mark-to-market exposure and counterparty credit risk (potential future exposure). Hedge effectiveness for the customer's position. |
| **Information** | Cost per record or query against price. Data-licensing and data-protection costs. Accuracy, and the cost of disputes and corrections. |
