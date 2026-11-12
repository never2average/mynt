---
name: review-product
description: Judge a product against the regulation Mynt has recorded for it — limits, misleading claims, disclosures. Use when job/case.json has subject_kind "product".
---

# Reviewing a product

The case gives:
- the product (name, line, category, risk level, return type, description, key features);
- its term sheet, if any;
- the build terms with required disclosures and banned phrases;
- the covering licence;
- the relevant legislation from Mynt's regulatory model, under `regulatory.law`, with ids and summaries.

You may quote the case itself with `"source_url": "mynt://case"`. Mynt checks the quote against the case it
gave you.

1. **regulatory_limits:**
   - For each law item that sets a limit or requirement relevant to this product, compare it with the product.
   - Quote the requirement (from the case, or from the regulator's page if you fetch the instrument) and the
     product text or term-sheet value it applies to.
   - A clear breach is `not_met`.
   - If the recorded law has no relevant limits, the status is `silent`, with `searched_for` naming the law
     items you checked.
   - Don't invent numbers that aren't in a source.
2. **claims_not_misleading:**
   - Quote the product text. Look for promises of guaranteed or assured returns on market-linked products,
     "risk-free" claims, or hidden costs on credit.
   - Look for claims the risk level or return type contradict, and phrases the build terms or the law forbid.
   - If there's nothing misleading, the status is `met`, quoting the description you assessed.
3. **disclosures_adequate:**
   - Compare the build terms' required disclosures with what the recorded regulation says customers must be
     told.
   - Missing a mandatory disclosure is `not_met`, quoting both.
