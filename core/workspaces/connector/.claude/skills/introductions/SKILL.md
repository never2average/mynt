---
name: introductions
description: Proposing and making double-opt-in introductions between innovators and developers (or innovators for distribution).
---

# Introductions

- **Propose** (`bd_propose_intro`) only when it clearly helps both sides. Examples: a firm that wants a savings
  app with a developer who builds them, or an issuer with a distributor for repackaging.
- **Ask each person separately,** by message, without revealing the other's contact details yet.
- **Record answers** with `bd_intro_answer`, using the message where they said it. Each answer is recorded as
  their consent to that introduction (`bd_check_consent` with `introductions`).
- **Make the introduction** (`bd_make_intro`) only once both said yes. Mynt sends each the other's details, and
  refuses otherwise.
- **If either says no,** drop it and don't tell the other who declined.
