# Task 10 — Serena Adapter

**Risk rationale:** Semantic navigation (success criterion #4) — only pays off if the added tool is worth its cost; lowest of the three integration risks.

**Status:** Implemented on branch `task/10-serena-adapter` (pending review/commit)
**Phase:** Phase 5
**Source:** `docs/plans/initial_design.md` — §6 Serena integration

## Objective

Create a Serena adapter that exposes semantic code navigation when the selected policy requires it.

## Details

Data flow when the policy calls for semantic navigation (e.g. debug/refactor/coding_new):

```
debug/refactor/coding_new
    ↓
Serena semantic search/navigation
    ↓
relevant symbols/files
    ↓
LeanCTX
```

- Do NOT duplicate Serena's functionality. Cadet Token Saver only decides **when** semantic navigation is appropriate and provides the integration layer.
- Decide appropriateness from the policy engine output (e.g. `code_search: semantic`).
- Adapter behind the shared `ContextOptimizer` interface (`name`, `isAvailable()`, optional `install()`/`configure()`).
- Return relevant symbols/files to be passed on to LeanCTX (Task 08).
- If Serena is unavailable, skip semantic navigation gracefully (no crash, no data loss).

## Acceptance Criteria

- [x] `isAvailable()` detects Serena correctly.
- [x] Exposes semantic search/navigation only when policy requests it.
- [x] Does not reimplement Serena logic (calls through to it).
- [x] Results are shaped for downstream LeanCTX consumption.
- [x] Serena unavailable → graceful skip with fallback.
