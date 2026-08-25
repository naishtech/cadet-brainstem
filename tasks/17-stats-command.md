# Task 17 — `stats` Command

**Risk rationale:** Low risk — terminal aggregation over the metrics store; first consumer that proves metrics are usable.

**Status:** Not started
**Phase:** Phase 8
**Source:** `docs/plans/initial_design.md` — §8 Metrics, §9 Dashboard

## Objective

Implement `token-optimizer stats` to print a terminal summary of saved/processed metrics from the local store.

## Details

Show (from the metrics store, Task 06):

- Estimated tokens processed
- Estimated tokens saved
- Percentage reduction
- Optimisation events count
- Savings by tool (RTK / LeanCTX / Serena)
- Savings by task type
- Sessions
- Average context reduction
- Most expensive operations

- All figures are ESTIMATES where not directly measured — clearly label them.
- Pure terminal output (no web UI needed here; that's Task 19).
- Must work fully offline.

## Acceptance Criteria

- [ ] Prints all listed summary statistics.
- [ ] Numbers derived from actual rows in the metrics store.
- [ ] Estimates clearly labelled as estimates.
- [ ] Works offline with no cloud dependency.
