# Task 20 — `telemetry` Command

**Risk rationale:** Low risk — toggles an off-by-default setting.

**Status:** Not started
**Phase:** Phase 10
**Source:** `docs/plans/initial_design.md` — §11 Telemetry

## Objective

Implement the `telemetry` subcommand surface for managing the opt-in setting.

## Details

Subcommands:

- `cadet-token-saver telemetry status` — show whether telemetry is on/off and exactly what is collected.
- `cadet-token-saver telemetry on` — opt in.
- `cadet-token-saver telemetry off` — opt out.

- Telemetry must be **OFF by default** unless explicitly opted in during setup.
- The user must be able to see exactly what is collected.
- This task wires the CLI surface to the telemetry setting; the actual telemetry collection interface is Task 21.
- Dashboard must work without telemetry (it does not depend on this).

## Acceptance Criteria

- [ ] `status` shows current state and the exact list of what would be collected.
- [ ] `on` / `off` persist the setting in config (`telemetry.enabled`).
- [ ] Default is off.
- [ ] Never collect source code, prompts, file names/paths, credentials, or repo identifiers.
