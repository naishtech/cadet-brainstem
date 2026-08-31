# 65 — Decoupled: re-point metrics to LeanCTX-only

**Status:** Planned (not yet implemented)

Part of the decoupled-architecture plan (`docs/plans/decoupled-architecture.md`).
After tasks 63–64, LeanCTX is the sole source of real token-savings. Metrics
aggregation must reflect only LeanCTX and stop surfacing zeroed Serena/RTK rows.

## Change matrix

### 1. `src/metrics/format.ts`
- `savingsByTool`, `getAverageCompressionRatio`, and `getSavingsByTaskType`
  should reflect only LeanCTX.
- Label Serena and RTK as `n/a` rather than `0` where they would otherwise
  appear.

### 2. `src/metrics/store.ts`
- Ensure `optimize_context` still writes savings rows after the gateway changes.
- Confirm `getTotals` / aggregation ignore/n/a Serena and RTK.

### 3. Dashboard
- `web/` + `src/dashboard/` stats surfaces show LeanCTX-only savings.

## Acceptance criteria
- `cadet-brainstem stats` "Savings by tool" lists only `leanctx`.
- No zeroed serena/rtk savings rows contribute to totals.
