# Task 54 — Dashboard: Vue 3 Frontend

**Risk rationale:** Low — isolated SPA; no impact on backend.

**Status:** Not started
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §6 Frontend Design

## Objective

Build the Vue 3 SPA: status icons, full stats grid, and the logs panel (Requests / Responses /
LLM Trace), fed by REST + SSE.

## Details

`web/` (Vue 3 + Vite + Pinia + Tailwind CSS, **no router** — single view):

- `api.ts` — typed fetch wrappers + one `EventSource('/api/events')`.
- `store.ts` (Pinia) — `status`, `stats`, `logs`, `traces`; SSE switch on `event.type`.
- `components/StatusIcons.vue` — green/amber/red icon per service (LLM, RTK, Serena, LeanCTX)
  with tooltip; live via SSE + initial `/api/status`.
- `components/StatsGrid.vue` — all `/api/stats` fields, ESTIMATES-labelled, dark theme.
- `components/LogsPanel.vue` — tabs [Requests | Responses | LLM Trace | All], virtualized list,
  auto-scroll with pause-on-scroll.
- `components/LlmTraceView.vue` — expandable cards streaming reasoning tokens (throttled
  render, "thinking…" indicator).
- Stats grid re-fetches on `stats.updated` SSE (Task 52).

## Acceptance Criteria

- [ ] Single page shows status icons, stats grid, and logs panel.
- [ ] Live updates flow from SSE without page reload.
- [ ] LLM trace cards render streamed reasoning; ESTIMATES labelled.
- [ ] Component tests (Vitest + Vue Test Utils) pass.
