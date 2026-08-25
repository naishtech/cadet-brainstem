# Task 26 — `wrap` Command (command output compression)

**Risk rationale:** Low — wraps the existing RTK adapter; targets the other big token sink (noisy command output) for VS Code tasks / terminal profiles.

**Status:** Not started
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §16 Integration & interception (VS Code)

## Objective

Add `cadet-token-saver wrap -- <command>` that runs a command and prints the RTK-compressed output before it reaches the agent.

## Details

- `wrap` runs the given command via `child_process`, pipes its output through the RTK adapter (Task 09), and prints the reduced output.
- Full/raw output must remain recoverable (safety principles §14.1 / §14.2) — e.g. a `--raw` flag or a saved copy.
- Records an `OptimisationEvent` (tool: `rtk`) with raw vs optimised sizes and estimated tokens saved.
- If RTK is unavailable, print the original output unchanged (graceful fallback).
- Safe to use in VS Code tasks / terminal profiles.

## Acceptance Criteria

- [ ] `cadet-token-saver wrap -- git status` prints reduced output.
- [ ] Raw output is preserved/recoverable.
- [ ] Falls back to the original output when RTK is missing.
- [ ] Records a metrics row for the wrap operation.
