# Task 16 — `config` Command

**Risk rationale:** Low risk — CRUD surface over the config module.

**Status:** Not started
**Phase:** Phase 1
**Source:** `docs/plans/initial_design.md` — §13 Configuration

## Objective

Implement `token-optimizer config` to view and edit configuration from the CLI.

## Details

- `token-optimizer config` with no args prints the effective (defaults-applied) configuration.
- Support viewing/editing individual values, e.g. `token-optimizer config set classifier.model <model>`, `token-optimizer config set session.max_turns 50`, `token-optimizer config set telemetry.enabled true`.
- Support `get <key>` to read a single value.
- Validate values before saving (reuse Task 02 schema).
- Show the config file path in output.
- Must not require manual YAML editing for common changes.

## Acceptance Criteria

- [ ] `config` prints full effective config.
- [ ] `config get <key>` returns a single value.
- [ ] `config set <key> <value>` updates and persists the value.
- [ ] Invalid values are rejected with a clear message.
- [ ] Output includes the config file location.
