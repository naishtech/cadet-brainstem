# Task 12 — Minimal State Handoff (`state.yaml`)

**Risk rationale:** Part of the session assumption — intentionally dumb handoff; tests bounded-session handoff before any State Tree is considered.

**Status:** Not started
**Phase:** Phase 9
**Source:** `docs/plans/initial_design.md` — §10 Session tracking

## Objective

Generate a very small handoff file `.token-optimizer/state.yaml` instead of a sophisticated State Tree.

## Details

Example shape:

```yaml
objective: "Fix Blueprint loading"

decisions:
  - "..."

unresolved:
  - "..."

pointers:
  - "Source/..."

last_action: "..."

next_action: "..."

```

- This is intentionally dumb — we want to test whether bounded sessions reduce cost before building a more sophisticated state-machine/state-tree system.
- The handoff file must be small and hand-editable.
- It should be generated/updated as part of session handling and available when starting a fresh session.

## Acceptance Criteria

- [ ] `state.yaml` is written to `.token-optimizer/` with the documented fields.
- [ ] File is small and human-readable.
- [ ] It is intentionally simple (no state machine / state tree logic).
- [ ] Handoff content is produced from tracked session info (objective, decisions, unresolved, pointers, last/next action).
