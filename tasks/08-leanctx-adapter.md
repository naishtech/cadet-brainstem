# Task 08 — LeanCTX Adapter

**Risk rationale:** Primary savings lever (success criterion #5) — the biggest contributor to context reduction, so its integration risk is de-risked first.

**Status:** Implemented on branch `task/08-leanctx-adapter` (pending review/commit)
**Phase:** Phase 6
**Source:** `docs/plans/initial_design.md` — §7 LeanCTX integration

## Objective

Create a LeanCTX adapter that acts as the context compiler, returning the right representation of context based on the policy decision.

## Details

Division of responsibility:

- Cadet Token Saver decides: "What type of context does this task need?"
- LeanCTX decides: "What representation of that context should be returned?"

Support the major strategies exposed by LeanCTX:

- full
- raw
- lines
- diff
- reference
- signatures
- map
- cognitive
- task
- density
- aggressive

- Do NOT reproduce LeanCTX's internal algorithms.
- Pass an appropriate mode/budget based on the policy (from Task 07).
- Adapter behind the shared `ContextOptimizer` interface.
- Record per event:
  - source size
  - returned context size
  - mode
  - estimated tokens saved
  - task classification
- If LeanCTX is unavailable, fall back gracefully (return unoptimised context, no data loss).

## Requirements & Installation

Prerequisite: LeanCTX (`lean-ctx`) — a local Rust binary (https://github.com/yvgude/lean-ctx).

**Windows:** download `lean-ctx-x86_64-pc-windows-msvc.zip` from the [releases page](https://github.com/yvgude/lean-ctx/releases), extract it, and put `lean-ctx.exe` on your PATH.

Other platforms: `curl -fsSL https://leanctx.com/install.sh | sh`, `brew install lean-ctx`, or `cargo install lean-ctx`.

Verify: `lean-ctx --version` or `lean-ctx doctor`.

Full requirements list: `docs/requirements.md`.

## Acceptance Criteria

- [ ] All listed LeanCTX modes are supported/passable.
- [ ] Mode and budget are chosen from the policy engine output.
- [ ] Does not reimplement LeanCTX algorithms (calls through).
- [ ] All five metrics fields recorded per event.
- [ ] LeanCTX unavailable → graceful fallback to unoptimised context.
