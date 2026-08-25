# Task 22 — Test Suite & Build/Package Scripts

**Risk rationale:** Deliverable — proves the riskiest assumptions were actually de-risked (mocked external tools).

**Status:** Not started
**Phase:** Final deliverables
**Source:** `docs/plans/initial_design.md` — §18 Development approach ("After each phase, write tests", "Prefer integration tests using mocked external tools")

## Objective

Provide a test suite and final build/package scripts so the result is a genuinely usable npm package.

## Details

- Tests written after each phase (Tasks 01–21), consolidated here into a runnable suite.
- Prefer integration tests using **mocked external tools** (RTK, Serena, LeanCTX, Ollama) so CI does not require every dependency to be installed.
- Cover, at minimum:
  - config load/save/validation
  - classifier schema validation + degradation
  - policy engine determinism
  - adapter `isAvailable()` and fallback behaviour (mocked tools)
  - metrics insert/aggregate
  - session turn-limit warning
  - CLI routing
- Build/package scripts: `build`, `test`, `lint`, `package`/`prepublish` producing an installable artifact.
- Final result must be a real npm package usable via `npx cadet-token-saver`, not a mock-only prototype.

## Acceptance Criteria

- [ ] `npm test` runs the full suite; all tests pass.
- [ ] External tools are mocked in tests; no hard dependency on their installation.
- [ ] Build + package scripts produce an installable npm artifact.
- [ ] `npx cadet-token-saver init` works from the packaged artifact.
- [ ] Tests run in CI without the external tools installed.
