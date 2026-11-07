# US on-ramp and off-ramp partners for the Mynt Ramp

Research for the Mynt Ramp's partner ([plan](../plans/crypto-liquidity.md), model R1): a US firm licensed to move money that holds funds in transit, turns US dollars into USDC and back, and offers an API Mynt can call. Gathered on 2026-11-07 from web search results pointing at each provider's own docs and legal pages.

**How far to trust it.** The official registers (FinCEN's MSB search, NMLS Consumer Access, NYDFS's licensee list) could not be opened from the research session. Every NMLS ID and state count below comes from the provider's own pages or the press, and **must be checked on those registers before any contract.** Facts without a source were left out.

**One design point.** For an issuer such as Circle (USDC), dollars become stablecoins 1:1, less fees, so a "firm price that expires" is mostly a fee quote. Mynt's quote → accept flow still fits: the quote carries the fee and the amount out. Zero Hash, Paxos, BVNK, Coinbase Prime and Circle (for cross-currency trades) have true expiring quotes.

## Comparison

| Provider | On / off | US bank rails | US licensing (provider's own pages; verify on the registers) | Quote → accept, settlement webhooks | Sandbox | Acts as the regulated party | Fit |
|---|---|---|---|---|---|---|---|
| **Zero Hash** | Both | ACH, wire | FinCEN MSB; money transmitter licences in "51 US jurisdictions"; NMLS 1699379; NYDFS virtual currency licence (2019) | Yes: quote, then execute by `quote_id`, with `expire_ts`; payment webhooks for posted, settled, returned | Yes | Yes: the platform distributes, Zero Hash is the licensed counterparty | **High** |
| **Bridge (Stripe)** | Both | ACH, wire; FedNow on its 2026 roadmap | Money transmitter licences held by Bridge Building Inc, NMLS 2450917; OCC conditional national trust charter (Feb 2026) | No expiring quote for USD → USDC (fees plus receipt); detailed transfer webhooks incl. returned and refunded | Yes | Yes: customers contract with Bridge; developers must not hold funds or keys | **High** |
| **BVNK** | Both | FedNow, Fedwire, ACH | System Pay Services (US) Inc d/b/a BVNK: FinCEN MSB, NMLS 2531294, licences "in various states" (a third party reports NY, CA, TX and NJ missing; unverified) | Rate acceptance tied to a quote; fiat and crypto payout webhooks | Yes | Yes, where licensed | **Medium-high** |
| **Circle (Mint / CPN)** | Both | Wire, RTP; ACH and FedNow "may" be available | NMLS 1201441; licences in 46 states, DC and PR; first NY BitLicense; OCC final approval for a national trust bank (2026-07-10) | Mint is 1:1 mint and redeem; cross-currency quotes lock about 3 s; webhooks | Yes | For its own account holder (an institution), not end customers | **Medium**, better as the liquidity layer |
| **Paxos** | Both | Wire, CUBIX; ACH not shown | Paxos Trust Company, N.A. (national trust charter, 2025-12-12); NYDFS consent order 2025-08-07 | Held-rate quotes with `expires_at`, then execution; expired quotes refused | Yes | As custodian and issuer; institutional | **Medium**, better as liquidity or custody |
| **Brale** | Both | ACH, wire, RTP | FinCEN MSB; "licensed or exempt in 45 US jurisdictions"; NMLS 2376957 | Transfers and virtual accounts; expiring quote not documented | Not confirmed | Yes | **Medium** |
| **Coinbase (Prime / CDP)** | Both | Prime: wire. Onramp: card, ACH | NMLS 1163082; licences in every state that requires them, DC and PR; NY BitLicense; OCC conditional trust charter (Apr 2026) | Prime: 1:1 USD/USDC conversion and RFQ. Onramp: quotes with `quote_id` | Onramp: yes | Onramp: customers become Coinbase customers. Prime: institutional | **Medium** (Prime) / **low** (Onramp) |
| **MoonPay** | Both | Card, bank | MoonPay USA LLC, NMLS 2071245; NY BitLicense, money transmitter licence and trust charter (2025); its own pages give 46 to 50 states | Consumer widget and headless API; business quote expiry not confirmed | Yes | Yes | **Medium-low** |
| **Stripe Crypto Onramp** | On only | Card, bank | Stripe is merchant of record; Hawaii excluded | Widget only | Yes | Yes | **Low** (use Bridge instead) |
| **Transak, Ramp Network, Alchemy Pay** | Both | Card, wire | Partial: about 11, a growing number, and 15 states | Consumer widgets | Yes | Partial US coverage | **Low** |

## Shortlist

1. **Zero Hash.** Closest to the Mynt Ramp's contract as built: quote, execute by quote id, expiry, and settled and returned webhooks. It is the licensed counterparty in about 51 jurisdictions including New York, and it is designed for platforms that never hold funds. Risk: a reported acquisition by Mastercard (October 2025), not confirmed as closed.
2. **Bridge (Stripe).** The cleanest "they are the regulated party" model, with mature bank-account on-ramps and return and refund webhooks. Gap: no expiring quote, so the Mynt Ramp's quote would carry Bridge's fees with a short validity set by Mynt.
3. **BVNK.** FedNow, ACH and Fedwire, quote-based rate acceptance, a sandbox. Gap: possibly missing state licences (NY, CA, TX, NJ), to confirm on NMLS.

Behind a ramp partner, **Circle** or **Paxos** are the natural USDC liquidity and custody layer.

## Sources

- **Zero Hash:**
  - about: [docs.zerohash.com/docs/what-is-zero-hash](https://docs.zerohash.com/docs/what-is-zero-hash)
  - licences: [docs.zerohash.com/page/us-licenses-and-disclosures](https://docs.zerohash.com/page/us-licenses-and-disclosures), [docs.zerohash.com/docs/permitted-and-restricted-jurisdictions](https://docs.zerohash.com/docs/permitted-and-restricted-jurisdictions)
  - NYDFS licence: [dfs.ny.gov press release](https://www.dfs.ny.gov/reports_and_publications/press_releases/pr1907151)
  - Indiana's licence record, which notes that its Indiana licence does not cover virtual currency: [extranet.dfi.in.gov](https://extranet.dfi.in.gov/ConsumerCredit/EntityDetails/17373)
  - on-ramp and off-ramp guides: [on-ramp](https://docs.zerohash.com/docs/on-ramp-integration-guide), [off-ramp](https://docs.zerohash.com/docs/off-ramp-integration-guide)
  - execute and errors: [execute](https://docs.zerohash.com/reference/post_liquidity-execute), [errors](https://docs.zerohash.com/docs/error-handling)
  - payment webhooks: [docs.zerohash.com/reference/payments-status-changes](https://docs.zerohash.com/reference/payments-status-changes)
  - Mastercard talks: [axios.com](https://www.axios.com/pro/fintech-deals/2025/10/29/zerohash-mastercard-merger)
- **Bridge:**
  - licences: [bridge.xyz/legal/licenses/us-licenses-and-registrations](https://www.bridge.xyz/legal/licenses/us-licenses-and-registrations)
  - developer agreement: [bridge.xyz/legal/developer-agreement](https://www.bridge.xyz/legal/developer-agreement)
  - virtual accounts: [apidocs.bridge.xyz virtual accounts](https://apidocs.bridge.xyz/get-started/guides/move-money/virtualaccounts)
  - transfer states: [apidocs.bridge.xyz transfer states](https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer-states)
  - OCC conditional charter: [pymnts.com](https://www.pymnts.com/bank-regulation/2026/stripe-owned-bridge-clears-occ-hurdle-for-federal-bank-charter/)
- **BVNK:**
  - US entity: [help.bvnk.com](https://help.bvnk.com/hc/en-us/articles/11094354781074)
  - rails: [docs.bvnk.com currencies](https://docs.bvnk.com/bvnk/references/currencies/)
  - integration: [docs.bvnk.com prepare for integration](https://docs.bvnk.com/bvnk/use-cases/stablecoin-payments-for-platforms/prepare-for-integration/)
  - third-party review (state gaps, unverified): [partnerkin.com](https://partnerkin.com/en/b2b/review/bvnk/)
- **Circle:**
  - licences: [circle.com/legal/licenses](https://www.circle.com/legal/licenses)
  - S-1 filing: [sec.gov](https://www.sec.gov/Archives/edgar/data/1876042/000119312525121234/d737521ds1a.htm)
  - OCC final approval: [theblock.co](https://www.theblock.co/post/407876/stablecoin-firm-circle-wins-final-occ-approval-to-open-national-trust-bank)
  - Mint deposits: [developers.circle.com](https://developers.circle.com/circle-mint/howtos/deposit-fiat)
  - redemption fees: [help.circle.com](https://help.circle.com/s/article/USDC-redemption-structure)
- **Paxos:**
  - licences: [paxos.com/terms-and-conditions/licenses](https://www.paxos.com/terms-and-conditions/licenses)
  - quotes: [docs.paxos.com quotes](https://docs.paxos.com/guides/crypto-brokerage/quotes/quickstart)
  - NYDFS consent order: [dfs.ny.gov](https://www.dfs.ny.gov/system/files/documents/2025/08/ea20250807-co-paxos-trust-co.pdf)
- **Brale:**
  - reserves: [docs.brale.xyz](https://docs.brale.xyz/documentation/platform/reserves)
  - media kit: [brale.xyz/media-kit](https://brale.xyz/media-kit)
  - pricing: [brale.xyz/pricing](https://brale.xyz/pricing)
- **Coinbase:**
  - licences: [coinbase.com/legal/licenses](https://www.coinbase.com/legal/licenses)
  - Prime conversions: [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com/prime/concepts/stablecoins/conversions)
  - Offramp quotes: [docs.cdp.coinbase.com offramp quotes](https://docs.cdp.coinbase.com/onramp/offramp/generating-quotes)
  - OCC conditional charter: [theblock.co](https://www.theblock.co/post/396244/coinbase-receives-conditional-approval-national-trust-charter-occ)
- **MoonPay:**
  - licences: [moonpay.com/legal/licenses](https://www.moonpay.com/legal/licenses)
  - NY trust charter: [moonpay.com/newsroom/nytrust](https://www.moonpay.com/newsroom/nytrust)
- **Stripe Crypto Onramp:** [docs.stripe.com/crypto/onramp](https://docs.stripe.com/crypto/onramp)

## Not verified

- Every NMLS ID, state count and NY status, against the official registers.
- Zero Hash: how long a quote lasts, RTP and FedNow, and whether the Mastercard deal closed.
- Bridge: the full state list, and whether it covers New York.
- BVNK: its state licences (NY, CA, TX, NJ in particular).
- Circle: ACH and FedNow for US Mint accounts.
- Paxos: its state licences and ACH.
- Brale: quote expiry and return webhooks.
- Onboarding minimums and pricing for Zero Hash, Bridge, BVNK, Paxos and Coinbase Prime: none published; all go through sales.
