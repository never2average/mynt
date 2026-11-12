---
name: mynt-sdk
description: Build on the generated Mynt SDK in job/sdk and test against Mynt's sandbox — use while coding any Mynt experience.
---

# Building on the Mynt SDK

`job/sdk/` (when present) is generated for exactly this app's products:
- `openapi.json`;
- a TypeScript client (openapi-fetch);
- Python helpers, with `python/generate.sh` to generate the Python client;
- each product's permitted hand-offs, required disclosures, banned phrases and branding.

- **Build on it** rather than calling the API by hand. Copy what you need into the project, for example under
  `src/mynt/`.
- **Get disclosures from the product's terms:** render them verbatim next to every place the product appears.
  Don't paraphrase them, and don't hide them behind a click.
- **Hand-offs:** a product's own flow takes over for anything involving money, KYC or applications. Use only
  the hand-off actions its terms permit.
- **End-to-end tests:** `$MYNT_SANDBOX_KEY` and `$MYNT_API_BASE`, when set, reach Mynt's sandbox, where
  hand-offs are simulated and there are no real customers. Use them in tests, read them from the environment,
  and never commit them.
