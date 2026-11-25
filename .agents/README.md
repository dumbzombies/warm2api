# .agents — memory bank

- `memory.md` — durable knowledge (decisions, invariants, gotchas). Append
  `## YYYY-MM-DD — <topic>`; never delete or rewrite history. Supersede a wrong
  entry with a newer one.
- `state.md` — always-current status: Goal, Progress, Blockers, Next actions.
  Rewritten in full; describes the code as it is now.
- `AGENTS.md` — memory-bank entry rules for any agent working here.

Session flow: read `state.md`, then `memory.md`; after a verified large change,
update both (`sync`).
