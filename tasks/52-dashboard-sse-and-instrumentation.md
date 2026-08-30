# Task 52 — Dashboard: SSE Logging + Instrumentation

**Risk rationale:** Medium — adds instrumentation into existing code paths; must stay non-blocking
and degrade gracefully.

**Status:** Done
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §5.4 SSE, §7, §9.2

## Objective

Stream logs to the front end over SSE and instrument the four sources so requests/responses
appear live.

## Details

- Add `GET /api/logs?limit=&since=` (from the ring buffer) and `GET /api/events` (SSE) that
  replays recent events then forwards live ones.
- Instrument (emit `request`/`response`/`log` events, non-blocking, never throwing):
  1. **MCP tool calls** — wrap tool execution in `src/mcp/`.
  2. **Classifier / classify** — `src/classifier/` (input hint, strategy, result).
  3. **`wrap` shell commands** — `src/cli/commands/wrap.ts` (command + compression stats).
  4. **Integration adapters** — RTK / Serena / LeanCTX activity.
- Respect `dashboard.captureFull`: when false, truncate `inputHint`/`outputHint`.
- `stats.updated` event is emitted after metric-affecting operations so the UI re-fetches.

## Acceptance Criteria

- [x] `GET /api/events` streams live `log`/`request`/`response`/`status`/`stats.updated`.
- [x] All four sources emit events without throwing or blocking.
- [x] `captureFull: false` truncates hints.
- [x] `GET /api/logs` returns recent buffered events.
