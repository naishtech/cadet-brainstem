# Task 11 — Session Tracking

**Risk rationale:** Bounded sessions (success criterion #7) — tests whether session limits reduce cost without breaking normal workflow.

**Status:** Not started
**Phase:** Phase 9
**Source:** `docs/plans/initial_design.md` — §10 Session tracking

## Objective

Implement a minimal session abstraction for the MVP.

## Details

Track per session:

- session_id
- started_at
- ended_at
- turn_count
- task classification
- estimated context size

Config:

```yaml
session:
  max_turns: 30
```

- When the configured turn limit is reached, emit a warning:
  `"Context session has reached 30 turns. Consider starting a fresh session."`
- Do NOT build a sophisticated State Tree in this MVP (that is explicitly out of scope).
- Do NOT implement automatic conversation summarisation (out of scope).
- Sessions should be creatable, incrementable (turn_count), closeable (ended_at), and queryable for metrics/dashboard.

## Acceptance Criteria

- [ ] Sessions can be started, incremented, and ended.
- [ ] All six tracked fields are persisted.
- [ ] Warning is emitted exactly when turn_count reaches `session.max_turns`.
- [ ] `max_turns` is configurable via config.
- [ ] No State Tree or auto-summarisation is introduced.
