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

## MCP `procedure_review` tool (DONE)

- New MCP tool `procedure_review {procedure_id, repo, step_index?}` — loads the
  procedure, fills each write step's args, builds its diff via `buildWriteDiff`,
  and returns `{ reviews: [{service, tool, args, path, kind, unsupported, diff, before, after}] }`
  WITHOUT applying. Registered in `TOOL_DEFS` + `handleToolCall`; exported from
  `src/mcp`.
- So the in-agent flow is: `classify` → matched write procedure flagged in
  `procedures_review` → cloud LLM calls `procedure_review` to get the concrete
  diff → user approves → apply (CLI `procedure run --yes` or review-gated run).

## Still to do (next)

- A dedicated `procedure_apply` MCP tool (approve + apply a reviewed write
  in-agent), and an automated diff-check on the apply side. Currently applying
  a reviewed change is via the CLI `procedure run` (y/n or `--yes`).

## Review-diff tool (DONE) — `src/procedure/review.ts`

- `buildWriteDiff(step, args, repoPath)` returns a concrete, reviewable proposal
  `{ path, kind: create|edit, before, after, diff, unsupported }` for a write
  step — WITHOUT applying. Supports `replace_content` (literal) and
  `create_text_file`; other write tools are `unsupported` (apply directly under
  review).
- Simple unified-ish diff (common prefix/suffix as context, changed middle as
  `-`/`+`).
- CLI: `cadet-brainstem procedure review <id> --repo <path>` prints the diff(s)
  for a procedure's write steps.
- Tests: `test/procedure-review.test.ts` (create diff, replace diff, unsupported).
- Note: with a generic (empty-args) procedure, the local LLM fills placeholder
  args, so the caller must supply concrete target args (handoff shape) for the
  diff to resolve to a real file.

## Agent-level review integration (DONE)

- `classify` now returns a `procedures_review` field alongside `procedures`:
  for every matched procedure that is `requires_review` or contains a write
  step, it lists `{ triggerPattern, steps, note }` with
  "Mutates the repo. Do NOT auto-execute — present the proposed change for
  user approval before running." This tells the cloud LLM to use the review
  gate rather than auto-running writes.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` pass.
- `executeProcedure` runs read-only steps and gates write steps behind `approve`,
  denying by default, and records outcomes only when fully executed.
- Tests inject fakes — no Ollama/Serena/LeanCTX needed to run the suite.
