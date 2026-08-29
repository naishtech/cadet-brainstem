# 49 — Live execution bridge + review gate for real-repo procedures

**Status:** Implemented (core module + tests)
**Prerequisite:** Tasks 44–48 (procedures, candidate harness, multi-step, handoff
shape) + real-repo read-only validation (`scripts/repo-readonly-smoke.ts`).

## Goal

Bridge the gap between "classify returns matched procedures" and actually
running them against a **real repo** safely. Two pieces:

1. **Live execution bridge** — take a matched `Procedure` + a real repo path and
   drive the local LLM to execute its steps against that repo via the
   Serena / LeanCTX adapters (no sandbox).
2. **Review gate** — `requires_review` (write) steps are gated behind an
   `approve` callback; they are never executed without approval, so writes can
   run on a real repo safely. Default is **deny** (safe).

## Deliverables

### 1. `src/procedure/execute.ts` — `executeProcedure(procedure, opts)` (DONE)

- `isWriteStep(step)` — flags mutating tools
  (`create_text_file`, `replace_content`, `replace_in_files`,
  `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`,
  `rename_symbol`, `safe_delete_symbol`, `replace_lines`, `delete_lines`,
  `insert_lines`, `insert_at_line`, `execute_shell_command`, `ctx_patch`,
  `ctx_shell`).
- For each step:
  - Fill args via `fillArgs` (default `defaultFillArgs` = local LLM,
    intent-grounded; injectable for tests).
  - **Read-only** steps → execute directly (verdict `auto`).
  - **Write** steps → call `approve(step, args)`; if approved → execute
    (verdict `review`, executed), else → `pendingReview` (not executed).
  - Default `approve` is `() => false` → **deny by default**.
- Lazily creates + activates a real Serena adapter (and LeanCTX) when steps
  need them and none is injected; closes them after.
- Records overall outcome via `ProcedureStore.recordOutcome` (only when fully
  executed; `success`/`failure`).

### 2. Exports (DONE)

`src/procedure/index.ts` exports `executeProcedure`, `defaultFillArgs`,
`isWriteStep` and the result/options types.

### 3. Tests (DONE) — `test/procedure-execute.test.ts`

Injected fake adapters + `fillArgs` (no Ollama). Covers:
- `isWriteStep` (write vs read-only tools).
- Read-only steps auto-run + outcome recorded as success.
- Write step **blocked** when approval denied (tool never invoked, pendingReview,
  no success recorded).
- **Deny-by-default** with no `approve` callback.
- Step error → recorded as failure.

### 4. CLI command (DONE) — `src/cli/commands/procedure.ts`

- `cadet-brainstem procedure list` — list seeded procedures + track records.
- `cadet-brainstem procedure run <id> --repo <path> [--yes]` — loads a procedure
  and runs it through the bridge; write steps prompt y/n unless `--yes`
  auto-approves. Registered in `src/cli/commands.ts` + CLI test updated.
- Validated live: read-only `find_symbol` ran against the real repo (success
  recorded); write step with `--yes` invoked the tool. Path args are normalized
  to repo-relative; `defaultFillArgs` prompts with per-tool param hints.

## Still to do (next)

- **Hook/agent integration**: surface the review gate to the cloud LLM so
  matched write procedures present a change for approval in the agent loop.
  (The CLI command is done; an in-agent review flow is the remaining piece.)

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` pass.
- `executeProcedure` runs read-only steps and gates write steps behind `approve`,
  denying by default, and records outcomes only when fully executed.
- Tests inject fakes — no Ollama/Serena/LeanCTX needed to run the suite.
