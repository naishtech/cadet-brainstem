# Task 15 — `doctor` Command

**Risk rationale:** Low risk — read-only health check; exposes environment state with actionable warnings.

**Status:** Not started
**Phase:** Phase 1
**Source:** `docs/plans/initial_design.md` — §12 Doctor command

## Objective

Implement `cadet-token-saver doctor` as a read-only environment health check.

## Details

Report on:

- Node.js
- npm
- Ollama
- Classifier model
- RTK
- Serena
- LeanCTX
- Metrics database
- Configuration

Example output format:

```
Cadet Token Saver Doctor

✓ Node.js
✓ npm
✓ Ollama
✓ Classifier model
✓ RTK
✓ Serena
✓ LeanCTX
✓ Metrics database
✓ Configuration
```

- Warnings must explain **exactly how to fix them** (e.g. install command or URL).
- Doctor must **not** automatically modify the user's environment — read-only.
- Exit code should reflect health (e.g. non-zero if critical checks fail) — decide and document the convention.
- Reuse adapters' `isAvailable()` and config/metrics checks from other modules.

## Acceptance Criteria

- [ ] All listed checks are performed and displayed with ✓ / warning.
- [ ] Warnings include actionable fix instructions.
- [ ] Doctor performs no writes or installs.
- [ ] Exit code reflects overall health per documented convention.
