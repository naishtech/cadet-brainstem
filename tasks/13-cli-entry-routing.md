# Task 13 — CLI Entry Point & Command Routing

**Risk rationale:** Low risk — thin shell; every command task (14–20) depends on it, so it precedes them in the build order.

**Status:** Not started
**Phase:** Phase 1
**Source:** `docs/plans/initial_design.md` — §1 CLI

## Objective

Implement the CLI entry point and route the top-level subcommands so each command lives in `src/cli/`.

## Details

Top-level commands to support:

- `cadet-token-saver init`
- `cadet-token-saver doctor`
- `cadet-token-saver stats`
- `cadet-token-saver dashboard`
- `cadet-token-saver config`
- `cadet-token-saver telemetry`

`telemetry` further takes sub-subcommands:

- `cadet-token-saver telemetry status`
- `cadet-token-saver telemetry on`
- `cadet-token-saver telemetry off`

- Use a CLI framework (e.g. `commander`) or a hand-rolled parser — keep it simple and typed.
- Unknown commands should print usage/help and exit with a non-zero code.
- Add a top-level `--help` and `--version` (from package version).
- Each subcommand should delegate to a module in `src/cli/` (stub implementations are fine for this task; wire real logic in later tasks).

## Acceptance Criteria

- [ ] Running `cadet-token-saver` with no args prints help.
- [ ] Each subcommand is registered and routes to its own module.
- [ ] `cadet-token-saver --version` prints the package version.
- [ ] Unknown subcommand exits non-zero with a helpful message.
- [ ] `telemetry status/on/off` are routed correctly.
