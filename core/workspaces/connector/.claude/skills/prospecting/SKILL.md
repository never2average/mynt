---
name: prospecting
description: Who Mynt's connector looks for (innovators and developers), where to find them in public sources, and how to record them with bd_add_prospect.
---

# Finding the right people

**Innovators** are licensed firms that could offer products on Mynt:
- banks, NBFCs, asset managers and insurers;
- brokers, exchanges and other intermediaries;
- mutual fund distributors;
- payment providers, custodians, depositories and trustees;
- trade-finance and guarantee providers, and securitisation and asset reconstruction firms;
- credit bureaus, account aggregators and rating agencies.

Start from public regulator registers and the firms' own websites. Look for the person who owns products,
distribution or partnerships.

**Developers** are people and teams who'd build on financial products: fintech products, AI agents, MCP tools.
Look at public GitHub profiles and projects, company sites and talks.

**Recording someone** with `bd_add_prospect`:
- what they do, and why Mynt fits them, in `profile`;
- the URL where you found them, in `source_url`;
- **contacts:** only details they or their firm published for business contact (consent `public_business`), or
  that a referrer gave (`referred`).

Never guess or construct an address. Never use personal details that weren't published for business contact.
Mynt refuses anyone who has opted out, under any name.
