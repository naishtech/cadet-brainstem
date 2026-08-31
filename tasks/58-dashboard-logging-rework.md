# Task 58 — Dashboard logging rework: Steering and Procedures streams

**Risk rationale:** Medium — web UI + EventBus event categorization; no change to classifier
behavior. Low runtime risk but touches the dashboard store/view and tests.

**Status:** Not started
**Phase:** Phase 15
**Source:** `docs/plans/dashboard-llm-thinking-trace.md` §9.1 (split into tasks 57–59)
**Order:** after task 59 (rename) and task 57 (thinking trace)

## Objective

Rework the dashboard `LogsPanel` from a single log feed into two scoped streams so the agent's
**Steering** decisions and **Procedures** execution are each visible on their own. This pairs
with the procedures-only thinking trace (task 57).

- **Steering** — routing/steering events: `classify`/`steering` results, `response_policy`,
  `tool_plan`, `strategy` decisions. Shows how the agent is steered.
- **Procedures** — procedure execution events (`procedure_review`/`procedure_apply`), step
  outcomes, and the **thinking trace** (the model's reasoning while running a procedure).

## Details

1. **Categorize events:** add a `category: 'steering' | 'procedures' | 'system'` to relevant
   `EventBus` `DashboardEvent`s (or infer from the existing `operation` field) so the store can
   split streams.
2. **Web store (`web/src/store.ts`):** maintain separate `steeringLogs` / `procedureLogs`
   arrays (or filter the existing log array by category).
3. **Web view (`web/src/components/LogsPanel.vue`):** render tabs/filter **All | Steering |
   Procedures**, with the thinking trace shown under Procedures.
4. Keep existing status/stats panels unchanged.

## Files

- `src/dashboard/event-bus.ts` — event `category`
- `src/dashboard/instrument.ts` — set `category` on published events (steering vs procedures)
- `web/src/store.ts` — split steering/procedures streams
- `web/src/components/LogsPanel.vue` — tabs/filter + scoped rendering

## Test Updates

- `test/dashboard-instrument.test.ts` — `category` on steering vs procedure events
- `test/dashboard-event-bus.test.ts` — category round-trip
- `web/src/components/__tests__/LogsPanel.test.ts` — tab filter shows Steering vs Procedures

## Acceptance Criteria

- [ ] `npm test` (backend) + `cd web && npm test` — all pass.
- [ ] `npm run build` — backend + web static build.
- [ ] Dashboard shows **Steering** and **Procedures** streams separately; a procedure run and a
      classify/steering decision each land in the right stream.
