---
name: review-entity
description: Check a firm (entity) against official company registries and GLEIF — registry match, active status, LEI. Use when job/case.json has subject_kind "entity".
---

# Reviewing a firm

The case gives the firm's legal name, its registration numbers (by type, e.g. a company number, an LEI, a
tax or regulatory identifier) and its regions.

1. **LEI first, if there is one.** It's the most reliable source to read automatically: run
   `python3 scripts/fetch_page.py https://api.gleif.org/api/v1/lei-records/<LEI>`. Quote the legal name, the
   entity status and the registration status from the saved JSON text.
   - **lei_consistent:** the name matches and the status isn't lapsed or retired.
   - It also counts as evidence for **registry_match** and **active_status** when GLEIF shows the business
     registry and the entity as active.
2. **The company registry.** India's Ministry of Corporate Affairs master data sits behind a captcha: don't
   try to get around it. Use other official or regulator pages that state the company number and status, or
   mark the item `silent` and say the registry needs a manual check. For other countries, use that country's
   official registry, if it can be read without signing in.
3. **registry_match:** a quote showing the registration number together with the legal name.
4. **active_status:** a quote showing an active status. "Struck off", "dissolved", "under liquidation" or
   "inactive" is `not_met`.

If the firm gave no identifier you can look up, every agent item is `silent`, with `searched_for` saying so.
