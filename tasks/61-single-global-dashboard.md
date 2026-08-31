# Task 61 — Single global dashboard (one port, multi-project)

**Status:** Not started
**Phase:** Phase 15
**Source:** observation — starting a new chat session / project spawns a new dashboard on a
different port, and a fresh window appears each time.

## Objective

Replace the per-project / per-session dashboard instances with **one global dashboard server on
a single port**. Events from any project (steering, procedures, stats, logs) are sent to that
single server and converge in one view, so running 2–3 projects doesn't spawn multiple ports or
windows.

## Details

1. **Single server lifecycle:** one long-lived global dashboard server (e.g. bound to a fixed
   port, auto-started once globally rather than per MCP process / per project). Multiple
   project processes connect to it instead of each starting its own.
2. **Event transport:** events are already persisted to a shared JSONL (`~/.cadet-brainstem/`
   `dashboard.log`), which the server tails — reuse/strengthen this as the convergence path so
   every project's events land in the one server without N servers.
3. **Port/window:** no new port per project; the server owns one port and one window.
4. **Project attribution (logging):** add the **project/workspace identity** to each event
   (steering, procedure, request/response, logs) so the dashboard shows **which project** called
   steering and/or a procedure. E.g. a `project`/`origin` field derived from cwd/workspace root.
5. **Dashboard UI:** show the project alongside each steering/procedure entry (or a filter).

## Files (indicative)

- `src/dashboard/server.ts` / `auto-start.ts` — single-server lifecycle + fixed port
- `src/dashboard/event-bus.ts` — `project`/`origin` on events
- `src/steering` / `src/procedure` / hooks — stamp project identity when emitting
- `src/mcp/server.ts`, `src/cli/commands/*` — connect to the shared server
- `web/src/*` — render project per entry

## Test Updates

- `test/dashboard-server.test.ts` — single server + project attribution round-trip
- `test/dashboard-event-bus.test.ts` — `project` field
- web store/panel tests — show project per steering/procedure row

## Acceptance Criteria

- [ ] One global dashboard on a single fixed port; multiple projects send events to it (no per-
      project ports/windows).
- [ ] Each steering/procedure event shows which project triggered it.
- [ ] Backend + web tests pass; build + lint clean.
