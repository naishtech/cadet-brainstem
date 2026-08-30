# Task 47 — Dashboard: Config Schema + CLI Command

**Risk rationale:** Low — additive config fields and a CLI command; no existing behaviour changes.

**Status:** Not started
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §8 Configuration, §9.1 CLI command
**Supersedes:** `tasks/18-dashboard-command.md` (old terminal-only plan)

## Objective

Add the `dashboard.*` config block and replace the `dashboard` CLI stub with a real command
that starts/stops the dashboard server and opens the browser.

## Details

Extend `configSchema` in `src/config/config.ts` (and `defaultConfig`) with:

```yaml
dashboard:
  enabled: true
  host: 127.0.0.1
  port: 4100            # distinct default; auto-increments if busy
  autoOpen: true
  autoOpenNonInteractive: false  # skip auto-open in CI / no-TTY
  statusIntervalSec: 30
  logRetention: 500     # in-memory ring buffer size
  persistLogs: true     # JSONL append to ~/.cadet-brainstem/dashboard.log
  captureFull: true     # full prompt/reasoning capture, local only
```

- Env overrides mirror existing conventions (e.g. `CADET_BRAINSTEM_DASHBOARD_PORT`,
  `CADET_BRAINSTEM_DASHBOARD_ENABLED`).
- Replace the stub in `src/cli/commands/dashboard.ts` (still registered in `COMMANDS`):
  ```
  cadet-brainstem dashboard            # start server + open browser (blocking)
  cadet-brainstem dashboard --no-open
  cadet-brainstem dashboard --port 4000
  cadet-brainstem dashboard --stop     # stop a running instance
  ```
- `--stop` requires a PID/instance registry (see Task 49 server lifecycle).

## Acceptance Criteria

- [ ] `configSchema` validates the new `dashboard.*` fields; defaults match the design exactly.
- [ ] Env overrides for port/enabled work.
- [ ] `dashboard` starts the server, `--port`/`--no-open` respected, `--stop` stops it.
- [ ] Invalid config produces clear errors.
