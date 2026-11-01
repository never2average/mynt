# CLAUDE.md

@AGENTS.md

@AGENTS.local.md

Claude Code notes (everything else is in AGENTS.md; `AGENTS.local.md` is imported when the machine has one):

- The hosted agents' own instructions are in `workspaces/<agent>/CLAUDE.md`, loaded as each agent's working directory. Edit them there; they don't apply to you.
- `!` commands put their output into this conversation, so the operator sets secrets on the server themselves, never through `!`.
