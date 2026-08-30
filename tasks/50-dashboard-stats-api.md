# Task 50 — Dashboard: Stats REST API + Shared Formatter

**Risk rationale:** Low — additive endpoint; refactor of `runStats` is contained.

**Status:** Done
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §5.2 REST, §5.6 Shared stats formatter

## Objective

Expose all `stats` command data as JSON and introduce a shared formatter so the CLI and
dashboard render identical numbers.

## Details

- Add `formatStats(store): StatsPayload` (shared module) returning the union of everything
  `runStats` renders as structured JSON: totals, reduction %, event count, avg ratio,
  savings-by-tool, savings-by-task-type, sessions, most expensive ops, call stats.
- Carry `estimated: true` on estimated token fields so the UI can show an ESTIMATES note.
- Refactor `runStats` (`src/cli/commands/stats.ts`) to consume the same payload (no drift).
- Add `GET /api/stats` returning `formatStats(...)`.
- Add `GET /api/health` → `{ ok: true, version }`.

## Acceptance Criteria

- [x] `GET /api/stats` returns the full structured payload.
- [x] CLI `stats` output matches the `/api/stats` numbers (same source).
- [x] Estimated fields are flagged `estimated: true`.
- [x] Existing `stats` tests still pass after the refactor.
