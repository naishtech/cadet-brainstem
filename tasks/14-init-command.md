# Task 14 — `init` Command

**Risk rationale:** Low risk — first-run UX that assembles config, metrics and adapters; no new assumptions, just wiring.

**Status:** Not started
**Phase:** Phase 1
**Source:** `docs/plans/initial_design.md` — §1 CLI (primary first-run experience)

## Objective

Implement the primary first-run experience: `cadet-token-saver init`.

## Details

The command must, in order:

1. Detect the operating system.
2. Detect whether Node/npm are available.
3. Detect whether Ollama is installed.
4. Detect whether RTK is installed.
5. Detect whether Serena is installed.
6. Detect whether LeanCTX is installed.
7. Report what is available.
8. Offer to install/configure missing components **where this can be done safely**.
9. Create a local Cadet Token Saver configuration (delegate to Task 02 config module).
10. Create a local metrics database/file (delegate to Task 06 metrics store).
11. Configure the integrations **without modifying the user's project source code unnecessarily**.

- Must be safe to run repeatedly (idempotent) — re-running should not corrupt config or metrics.
- Availability checks should reuse the integration adapters' `isAvailable()` where possible (Tasks 08–10).
- Install/configure steps must be optional and only done with explicit user consent; do not modify the user's environment without confirmation.
- When offering to install missing components, use the documented commands (see `docs/requirements.md`). On Windows: RTK and LeanCTX install via their GitHub release zips (`rtk-x86_64-pc-windows-msvc.zip`, `lean-ctx-x86_64-pc-windows-msvc.zip`) placed in `~/.local/bin`.

## Acceptance Criteria

- [ ] Running `init` on a clean machine reports each tool as available/unavailable clearly.
- [ ] Config file is created at the documented path.
- [ ] Metrics database is initialized (empty, valid schema).
- [ ] Re-running `init` is safe and does not duplicate or corrupt state.
- [ ] Install/configure actions are consent-gated and never modify project source unnecessarily.
- [ ] Prints a clear summary of what was found and what was configured.
