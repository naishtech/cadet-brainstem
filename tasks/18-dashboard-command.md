# Task 18 — `dashboard` Command

**Risk rationale:** Low risk — local server hosting the metrics UI.

**Status:** Not started
**Phase:** Phase 8
**Source:** `docs/plans/initial_design.md` — §9 Dashboard

## Objective

Implement `cadet-token-saver dashboard` to launch a lightweight local web dashboard.

## Details

- Start a local HTTP server serving a minimal dashboard.
- Show:
  - Estimated tokens processed
  - Estimated tokens saved
  - Percentage reduction
  - Optimisation events
  - Savings by tool
  - Savings by task type
  - Sessions
  - Average context reduction
  - Most expensive operations
- Data comes from the metrics store (Task 06).
- Clearly label all numbers as ESTIMATES where not directly measured.
- Must work offline and without telemetry.
- Do not build a complicated UI — lightweight is sufficient for MVP.
- Decide and document the port (e.g. default 3000 or similar) and how to stop the server.

## Acceptance Criteria

- [ ] `dashboard` starts a local server and serves a working page.
- [ ] All listed metrics are displayed.
- [ ] Estimates are clearly labelled.
- [ ] Works offline; no telemetry required.
- [ ] Documented way to choose the port and stop the server.
