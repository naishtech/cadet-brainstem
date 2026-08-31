# Task 58 — Dashboard logging rework: Steering and Procedures streams

**Risk rationale:** Medium — web UI + EventBus event categorization; no change to classifier
behavior. Low runtime risk but touches the dashboard store/view and tests.

**Status:** Done — LogsPanel reworked to All | Steering | Procedures streams; thinking trace
under Procedures. Implemented via **web-side inference from the `operation` field** (the
approach the task explicitly permits) — no backend `category` field added.

**Smoke-test fix:** `executeProcedure` is now instrumented (best-effort) to emit a `request`
(`procedure_run`), per-step `log`s (source `procedure`), and a `response` + `stats.updated` so
every procedure run — CLI, MCP, or test — surfaces as a logged entry in the Procedures stream
(not just the fill thinking trace).
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

- `web/src/types.ts` — `EventCategory` type + added the `llm.trace.think.*` events (task 57 gap)
- `web/src/store.ts` — `categoryOfEvent`/`categoryForOperation` inference; `_reqCat` id map for
  responses; `category` on `Trace`; `steeringLogs`/`procedureLogs`/`steeringTraces`/
  `procedureTraces` getters; lazily create procedure traces from think events
- `web/src/App.vue` — pass the categorized getters to LogsPanel
- `web/src/components/LogsPanel.vue` — **All | Steering | Procedures** tabs + scoped rendering

(No `src/dashboard/event-bus.ts` / `instrument.ts` change: categorization is inferred in the
web store per the task's allowed alternative.)

## Test Updates

- `web/src/components/__tests__/LogsPanel.test.ts` — Steering vs Procedures tab filtering +
  thinking trace under Procedures
- `web/src/store.test.ts` (new) — category inference: steering/procedure routing, response
  id-matching, think-event trace creation

## Acceptance Criteria

- [x] `npm test` (backend) + `cd web && npm test` — all pass.
- [x] `npm run build` — backend + web static build.
- [x] Dashboard shows **Steering** and **Procedures** streams separately; a procedure run and a
      classify/steering decision each land in the right stream.
