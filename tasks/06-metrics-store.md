# Task 06 — Metrics Store (SQLite)

**Risk rationale:** Measurement validity — the MVP's entire value is proving savings (success criterion #6). If estimates can't be recorded reliably, the thesis can't be proven at all.

**Status:** Not started
**Phase:** Phase 7
**Source:** `docs/plans/initial_design.md` — §8 Metrics

## Objective

Create the local metrics store (SQLite preferred) that records optimisation events.

## Details

Record optimisation events shaped like:

```
{
  timestamp,
  session_id,
  task_type,
  complexity,
  risk,
  tool,
  operation,
  estimated_input_tokens,
  estimated_output_tokens,
  estimated_tokens_saved,
  compression_ratio,
  optimisation_strategy
}
```

- SQLite is preferred (e.g. `better-sqlite3`).
- The store must work **completely offline**.
- Do NOT store (unless a future debug mode explicitly enables it):
  - source code
  - full prompts
  - conversation contents
  - API keys
  - credentials
  - file contents
- Created/initialized by `init` (Task 14); read by `stats` (Task 17) and `dashboard` (Task 18).
- Provide insertion + aggregation query helpers (totals, savings by tool, savings by task type, average reduction, most expensive operations).
- Metrics are estimates — store them as such and label them in output.

## Acceptance Criteria

- [ ] SQLite database created at a stable documented path.
- [ ] Schema stores all listed fields.
- [ ] Insert + aggregate queries work offline.
- [ ] No forbidden content types are ever stored.
- [ ] Aggregations power `stats` and `dashboard` correctly.
