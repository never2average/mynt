---
name: review-licence
description: Check a firm's claimed licence against the regulator's own public register — entry, holder, type, in force, enforcement. Use when job/case.json has subject_kind "license".
---

# Reviewing a licence

The case gives the regulator (`regulatory.regulator`), the licence type (`regulatory.licence_type`), the
registration number, the validity dates the firm entered, and the firm's legal name.

1. **Find the official register.** It's the regulator's own website. Search for the regulator's name plus
   "registered entities", "list of", "intermediaries", "registration search" or the licence type's name.
   Typical forms:
   - a search page by registration number or name;
   - a published list (an HTML table or a downloadable file).

   Only quote the regulator's own domain. If the register is only a PDF or spreadsheet, fetch an HTML page
   that links to it as context. Then try to find the same entry in an HTML view (many regulators have one). If
   you can't, mark the items `silent` and say which file holds the answer.
2. **register_entry:** quote the row or record showing the registration number.
3. **holder_matches:** quote the holder's name from that entry. Legal-form abbreviations (Ltd/Limited,
   Pvt/Private, &/and) are fine. A different company is `not_met`.
4. **type_matches:** quote what the register says the registration is for. Compare it with the licence type's
   name and scope in the case.
5. **in_force:** quote the status or validity. Cancelled, surrendered, suspended or expired is `not_met`. An
   entry with no status shown and nothing adverse is `met` only if the register lists current entities only.
   Quote where it says so.
6. **no_enforcement:** search the regulator's enforcement, orders, penalties and cancellation pages for the
   firm's name and registration number. If you find nothing, the status is `met`, with `searched_for` listing
   the pages and terms. If you find something, quote it and judge whether it's serious and unresolved.

Record every search term and page you tried, especially when you couldn't find something.
