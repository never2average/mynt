<div align="center">

# Mynt

### Lovable for finance apps.

Describe the finance app you want. Mynt's agents build it on real, regulated financial products, check it, and put it live.

**[Get early access](https://github.com/never2average/mynt/issues/new?title=Early%20access%20request)** · [How it works](#how-it-works) · [Technical reference](docs/reference.md)

</div>

---

## Ask for an app. Get an app.

> Build a savings app on the recurring deposit, with a web app and a mobile app.

Mynt takes it from there:

1. **Plans** the app: which products, which customer journeys, which screens.
2. **Builds** it: a server, a web app and a mobile app, on SDKs generated for exactly those products.
3. **Checks** it against every product's rules: required documents shown word for word, consent before anything that needs it, no misleading claims.
4. **Verifies** it in a clean sandbox the agents never touched: tests, security scans and an independent audit.
5. **Puts it live** on its own isolated server, with a public web address.

You step in only when Mynt needs you: an approval, a repository, a login.

## Built for three kinds of people

| | |
|---|---|
| **Licensed firms** (banks, lenders, insurers, brokers) | Compose a product from regulated building blocks, see exactly which licences and obligations it carries, price and test it, then open it to developers. |
| **Developers** | Build apps on those products with coding agents, without ever holding customers' money or financial data. |
| **Service providers** (identity, KYC, bank data, credit bureaus, e-sign) | Plug a service in once, get tested by Mynt, and be used by every firm that needs it. |

## Why Mynt

**Products are composed, not hand-built.** A recurring deposit is a payment mandate plus a term deposit. A foreign transfer is a currency exchange plus a payment. Because every product is made of regulated building blocks, it stays small, reviewable and easy to change.

**Regulation is worked out, not remembered.** Regulators, licences and law are data. From a product's building blocks, Mynt works out which rules apply and blocks publishing until the firm behind it is covered.

**Agents build; Mynt checks.** No agent grades its own work. A build ships only if Mynt's own checks pass in a sandbox the agent never touched.

**Keys and customer data stay out of reach.** An app's key never sits on a developer's machine or a customer's phone: devices get short-lived sessions. Customer data sits in one encrypted vault, collected only after consent and erasable on request.

**Every app is isolated.** Each hosted app gets its own microVM, its containers run sandboxed, and it can reach only the services it needs.

**Every cost is counted.** Build, model and hosting spend are measured against caps, and a number that can't be measured is never shown as zero.

## How it works

```
 idea ──► compose ──► review ──► publish ──► build ──► verify ──► host ──► customers
          firms        Mynt        to          agents    clean      own        web, mobile,
                       checks      developers            sandbox    server     chat
```

A customer can also just ask, in plain words:

```
You:   I need ₹80,000 of stock for six weeks before Diwali.
Mynt:  Got it. Should repayments come from your daily settlements?
You:   Yes, a little every day.
Mynt:  ┌─────────────────────────────────────────────┐
       │ SIX-WEEK STOCK LOAN · READY                 │
       │ ₹80,000 · 6 weeks · 12% p.a. · partner bank │
       │ [ Accept ]  [ Look for more options ]       │
       └─────────────────────────────────────────────┘
```

## Measured

- **The live regulatory model holds 62 regulators, about 766 licence types, 712 product types and about 2,030 items of law.**
- **A hosted app's server boots in about a second,** and a two-service app built and started in 16 seconds.
- **Every change builds and runs the starter app** in CI, from a freshly generated SDK.

## Works with the tools you already use

Mynt is an [MCP](https://modelcontextprotocol.io) server, so it works in any MCP client: Claude Code, your IDE, or the sample chat app in [`examples/mynt-chat`](examples/mynt-chat). Generated SDKs cover TypeScript, React Native, Kotlin, Swift, Flutter and Python.

## Business model

A take rate on every product sold, set per product line and proportional to the compliance and operations work each product carries. More regulation and more servicing pay proportionally more.

## Learn more

- **[Technical reference](docs/reference.md):** every tool, the runtime API, hosting, install and deployment.
- **[Architecture](docs/architecture.md):** how the parts fit together.
- **[For coding agents](AGENTS.md):** rules for working in this repository.

## Disclaimer

Mynt ships no catalogue: every product comes from an innovator, the firm that offers it. Product information is for informational purposes, contains no live rates and is not financial advice. Rules change, so verify with the relevant regulator or provider. Enrollments here are records in this server's database, not real accounts.

## License

MIT
