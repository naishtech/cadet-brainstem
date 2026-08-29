# 46 — Procedure candidates: progressive local-LLM performance tests

**Status:** Planned (not yet implemented)
**Phase:** Two-phase effort (Phase 2 = this task; Phase 1 = task 45)
**Prerequisite:** Phase 1 (task 45) complete — the agent-curated candidate test
files exist and a batch is approved.

## Goal

Take the **agent-curated candidate test files** from Phase 1 and use them to
measure how the **local LLM performs at executing procedures**, progressively
from easy to hard. The local LLM does **no mining** — it only *executes* the
curated candidates. Each candidate becomes a test; we run them in difficulty
order and record pass/fail per candidate.

## Scope & hard constraints

- The local LLM is used **only for execution**, never for mining/classification
  (mining is the agent's job in Phase 1).
- Nothing is auto-promoted. Any candidate promoted to the live `procedures`
  table starts `risk_tier: "requires_review"` — never `auto_execute` without
  explicit user confirmation.
- This task must not touch the memory service or its data (same constraint as
  task 45).

## Deliverables

### 1. Progressive test harness (`mine test`)

Read the candidate test files (e.g. `test/candidates/*.json`, each with
`trigger_pattern`, `keywords`, `steps`, `difficulty`, `source_conversation_id`).

- Order candidates by `difficulty`: **easy → medium → hard**.
- For each candidate, run the **local LLM** on the task and let it drive the
  relevant tool (RTK via `compress_command_output`, LeanCTX, Serena) to execute
  the steps. This is the same handoff path used in production (task 44's
  `findMatches` → `procedures` handoff).
- Record per candidate: did it run? did it produce the expected output? pass /
  fail / degraded (tool or model unavailable).

### 2. Report — `mine test --report`

Output a per-candidate table:
- candidate id / trigger pattern / difficulty
- tool used (RTK / LeanCTX / Serena)
- result: pass | fail | degraded
- any output/summary

Plus a summary across difficulty tiers (easy/medium/hard pass rates). This tells
us what the local LLM can reliably execute, and where it needs a better model or
better candidates.

### 3. CLI wiring

- Add `cadet-brainstem mine test` (and `--report`) subcommand, registered in
  `src/cli/commands.ts`.
- Update `test/cli.test.ts` command list.
- Tests: `test/mine-candidates.test.ts` (candidate-file loading + difficulty
  ordering + report building).

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- `mine test` runs candidates in difficulty order (easy → hard), executes each
  with the local LLM driving the tool, and records pass/fail/degraded.
- `mine test --report` prints the per-candidate table + per-tier pass rates.
- Candidate files are loaded from `test/candidates/*.json`.
- Nothing is promoted or defaulted to `auto_execute` without explicit user
  approval.

