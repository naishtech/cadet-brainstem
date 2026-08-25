# Task 09 — RTK Adapter

**Risk rationale:** Terminal-output reduction (success criterion #3) — external-tool dependency with a strict no-data-loss constraint.

**Status:** Implemented on branch `task/09-rtk-adapter` (pending review/commit)
**Phase:** Phase 4
**Source:** `docs/plans/initial_design.md` — §5 RTK integration

## Objective

Create an RTK adapter that reduces noisy terminal output before it becomes agent context, while never destroying the original output.

## Details

Data flow:

```
Agent command
    ↓
Cadet Token Saver
    ↓
RTK
    ↓
reduced output
    ↓
agent
```

- If RTK is unavailable, fall back to the normal command path (no optimisation).
- **Never destroy the original output** — the full output must remain recoverable.
- Record per optimisation event:
  - command
  - raw output size
  - optimised output size
  - estimated tokens before
  - estimated tokens after
  - estimated tokens saved
  - timestamp
- These records feed the metrics store (Task 06).
- Implement as an adapter behind the shared `ContextOptimizer` interface (see §2), i.e. `name`, `isAvailable()`, optional `install()`/`configure()`.
- Do NOT fork or reimplement RTK — orchestrate it.

## Requirements & Installation

Prerequisite: RTK (`rtk`) — a single Rust binary (https://github.com/rtk-ai/rtk).

**Windows:** download `rtk-x86_64-pc-windows-msvc.zip` from the [releases page](https://github.com/rtk-ai/rtk/releases), extract it, and put `rtk.exe` on your PATH.

Note: the `install.sh` script is Linux/macOS only — it does NOT support Windows/Git Bash.

Verify: `rtk --version`.

Full requirements list: `docs/requirements.md`.

## Acceptance Criteria

- [ ] `isAvailable()` detects RTK correctly.
- [ ] Command output passes through RTK and returns reduced output.
- [ ] Original full output is preserved/recoverable.
- [ ] All seven metrics fields are recorded for each event.
- [ ] RTK missing → transparent fallback to normal command path.
- [ ] Adapter implements the shared interface.
