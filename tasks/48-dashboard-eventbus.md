# Task 48 — Dashboard: EventBus + Ring Buffer + JSONL Persistence

**Risk rationale:** Low — new in-process module; no existing behaviour touched.

**Status:** Not started
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §5.3 EventBus

## Objective

Build the process-wide `EventBus` (a typed `EventEmitter` singleton) that carries all live
dashboard events, keeps an in-memory ring buffer, and optionally persists to a JSONL file.

## Details

`src/dashboard/event-bus.ts`:

- Export an `EventBus` class wrapping `node:events` `EventEmitter`, plus a singleton instance.
- Event union (from design §5.3):
  - `log` (level, source, message)
  - `request` / `response` (id, tool, operation, latency, hints)
  - `status` (services: `ToolStatus[]`)
  - `llm.trace.start` / `llm.trace.token` / `llm.trace.complete`
  - `stats.updated`
- Maintain an in-memory **ring buffer** (capacity from `dashboard.logRetention`, default 500)
  so `/api/logs` and SSE replay work for the process lifetime.
- When `dashboard.persistLogs` is true, append each event as a JSON line to
  `~/.cadet-brainstem/dashboard.log` (bounded append, no rotation in MVP).
- `subscribe(fn)`, `publish(event)`, `recent(limit, since?)`, and helper emit methods.

## Acceptance Criteria

- [ ] Events round-trip: publish → subscriber receives typed event.
- [ ] Ring buffer respects capacity and returns newest-first.
- [ ] With `persistLogs` on, events are appended as valid JSONL; off ⇒ no file writes.
- [ ] Singleton is shared (same instance imported anywhere).
