# Task 55 — Dashboard: Build, Packaging, Tests, Docs

**Risk rationale:** Low — build wiring and verification; no runtime logic.

**Status:** Done
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §11 Packaging & Build, §12 Testing, §13 Milestones

## Objective

Wire the Vue build into the npm package, add integration/frontend tests, and update docs.

## Details

- Vite builds the SPA to `web/dist`; root `tsup.config.ts` copies it to
  `dist/dashboard/static/` so the package ships prebuilt assets (no Node tooling at runtime).
- CI builds `web/` before the root build (`cd web && npm ci && npm run build`).
- Tests:
  - Unit: `EventBus`, SSE serialization, REST handlers (ephemeral port + temp metrics DB).
  - Integration: start `DashboardServer`, assert `/api/stats`, `/api/status`, `/api/logs`, and
    SSE emits when classifier/integrations fire.
  - E2E: Playwright smoke — page loads, status icons + stats + logs render.
- Docs: update `docs/requirements.md` and `docs/plans/dashboard.md` statuses; add run/stop
  instructions; note port default 4100 and localhost-only.
- Regression: existing suite stays green (`npm run typecheck && npm run lint && npm test`).

## Acceptance Criteria

- [x] `npm run build` produces a package that serves the dashboard offline, no dev tooling.
- [x] Integration + unit tests pass; Playwright smoke passes.
- [x] Docs updated (port, lifecycle, `--stop`).
- [x] Full regression suite green.
