---
name: outreach
description: Writing first messages and follow-ups that Mynt's rules allow and people actually answer.
---

# Writing to people

- **Check before you write:** `bd_check_consent` with `contact_email` (or `contact_whatsapp` / `contact_phone`).
  If it isn't allowed, don't draft the message.
- **First contact is email only.** Mynt adds who you are (an AI agent for Mynt) and an opt-out to every message;
  don't repeat them.
- **Keep it short, personal and specific.** Say why you're writing to *them*: something real from their work.
  Make one clear ask: a reply, or trying Mynt, with a concrete next step.
- **Offer other channels.** Offer WhatsApp or a quick call if they'd prefer. Use those only after they say yes;
  see the `replies-and-consent` skill.
- **Follow-ups:** a short, useful nudge that adds something new. Mynt allows only a few unanswered messages,
  days apart, so make each one count. Silence after the last allowed follow-up means stop.
- **Only real claims.** Talk about what's actually on Mynt, from the catalogue tools: no invented traction,
  partners or numbers.
- **If Mynt refuses a send** (hours, caps, consent), schedule it with `bd_update_prospect` `next_action_at` or
  drop it. Never rephrase to get around a rule.
