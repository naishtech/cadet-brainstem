# Task 51 — Dashboard: Service Status API + Live Broadcast

**Risk rationale:** Low — additive status endpoint; reuses existing detection.

**Status:** Done
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §5.5 Status, §5.4 SSE

## Objective

Expose live service status for the local LLM (Ollama), RTK, Serena, and LeanCTX as icons, and
broadcast changes via SSE.

## Details

- Add `GET /api/status` returning `ToolStatus[]` for the four services by calling
  `detectEnvironment()` (`src/core/environment.ts`) plus a classifier model check via
  `isModelAvailable()`.
- `ToolStatus = { name, available, detail?, kind: 'llm'|'rtk'|'serena'|'leanctx' }`.
- Live refresh: re-check on `dashboard.statusIntervalSec` (default 30s) **and** when a
  status-related event fires; broadcast via SSE `status` event.
- Publish a `status` event on the `EventBus` after each check so the front end stays in sync.

## Acceptance Criteria

- [x] `GET /api/status` returns accurate availability + version detail per service.
- [x] Status re-checks on the configured interval and pushes SSE `status` events.
- [x] Graceful if a tool is missing (available:false + hint, no throw).
