# Task 19 — Dashboard Web UI

**Risk rationale:** Low risk — static presentation of metrics; estimates clearly labelled.

**Status:** Not started
**Phase:** Phase 8
**Source:** `docs/plans/initial_design.md` — §9 Dashboard

## Objective

Build the lightweight local web UI served by the `dashboard` command (Task 18).

## Details

Show:

- Estimated tokens processed
- Estimated tokens saved
- Percentage reduction
- Optimisation events
- Savings by tool
- Savings by task type
- Sessions
- Average context reduction
- Most expensive operations

Reference layout from the design doc:

```
Cadet Token Saver

Estimated tokens saved
4.2M

Context reduction
68%

RTK
1.4M saved

LeanCTX
2.1M saved

Serena
700K saved

Debugging
highest context usage
```

- Clearly label all numbers as ESTIMATES where not directly measured.
- Do not pretend to know exact model billing unless actual provider usage data is available.
- Lightweight, no complicated UI, no cloud, works without telemetry.
- Served by the local server started in Task 18.

## Acceptance Criteria

- [ ] All listed metrics are rendered.
- [ ] Estimates are clearly labelled.
- [ ] No cloud/telemetry dependency.
- [ ] Page works with real data from the metrics store.
