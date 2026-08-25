# Task 21 — Telemetry Interface

**Status:** Not started
**Phase:** Phase 10
**Source:** `docs/plans/initial_design.md` — §11 Telemetry

## Objective

Implement the optional anonymous telemetry interface (the transport/collection layer; the CLI toggles are Task 20).

## Details

- Must be **OFF by default** unless the user explicitly opts in during setup.
- The user should see exactly what is collected.
- Potential telemetry:
  - anonymous installation ID
  - OS
  - Cadet Token Saver version
  - tool versions
  - task classification
  - estimated token savings
  - compression ratios
  - optimisation strategy
  - aggregate session statistics

- Never collect:
  - source code
  - prompts
  - conversation text
  - file names
  - file paths
  - credentials
  - API keys
  - repository identifiers

- Design the interface so a cloud backend can be added later, but do NOT build the cloud backend in this MVP.
- Core functionality must never depend on connectivity.
- Dashboard works without telemetry.

## Acceptance Criteria

- [ ] Telemetry interface exists with a pluggable transport design (backend can be added later).
- [ ] Nothing is sent unless `telemetry.enabled` is true.
- [ ] Collected fields restricted to the allowed list; forbidden fields never sent.
- [ ] Offline core functionality is unaffected when telemetry is off or unreachable.
- [ ] Anonymity: installation ID is anonymous; no repo identifiers.
