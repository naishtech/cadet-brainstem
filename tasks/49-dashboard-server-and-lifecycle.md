# Task 49 — Dashboard: HTTP Server + Static Serving + Browser Open + Lifecycle

**Risk rationale:** Low — new local server; isolated from existing logic.

**Status:** Done
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §5.1 Server, §9.2 Lifecycle, §10 Security

## Objective

Implement `DashboardServer` (`node:http`) that serves the built Vue static assets and the
REST/SSE API, plus cross-platform browser open and the auto-start lifecycle.

## Details

`src/dashboard/server.ts`, `src/dashboard/router.ts`, `src/dashboard/stream.ts`,
`src/dashboard/open-browser.ts`:

- `DashboardServer.start({ host, port, autoOpen })` → binds to `127.0.0.1`, auto-increments
  port if busy (bounded range), returns `{ host, port, url }`.
- Serve static assets from `dist/dashboard/static/` with correct MIME types and an
  `index.html` fallback for the SPA.
- Route table: `/api/health`, `/api/config`, plus placeholders wired by Tasks 50–52.
- SSE helper: `text/event-stream`, heartbeat comment every 15s, multi-subscriber support.
- `open-browser.ts`: cross-platform open (`start` / `open` / `xdg-open`), respect `BROWSER`,
  **skip when non-interactive** (no TTY) or `CADET_BRAINSTEM_CI=1`.
- Lifecycle: idempotent start (singleton, no-op if running), `stop()`, `isRunning()`, and a
  PID/instance registry so `dashboard --stop` works.
- Security: bind `127.0.0.1` only, never `0.0.0.0` by default.

## Acceptance Criteria

- [x] Server serves the SPA `index.html` and static assets on `127.0.0.1`.
- [x] Port auto-increments when the default is busy.
- [x] Browser opens on start when interactive; skipped in CI/no-TTY.
- [x] `stop()` shuts down cleanly; `start()` is idempotent.
- [x] SSE connection sends heartbeats and supports multiple subscribers.
