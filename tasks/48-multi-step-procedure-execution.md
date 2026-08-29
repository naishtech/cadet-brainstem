# 48 — Multi-operation procedures: can the local LLM string together a task list?

**Status:** Planned (design note / possible test)
**Prerequisite:** Tasks 44–46 (procedures + candidate harness + single-step
performance tests). We have single-step candidates 001–022 confirmed for
Serena + LeanCTX; this extends them to **multi-step** sequences.

## Motivation

Every candidate tested so far is a **single operation** (one tool call:
`create_text_file`, `read_file`, `find_symbol`, `replace_content`, `ctx_tree`,
...). But real procedures (task 44) are **ordered lists of steps**
(`Procedure.steps: {service, tool, args?}[]`), and the cloud LLM routinely does
2–3+ operations back-to-back in one turn (e.g. *read the file → find the
symbol → edit the file → verify*).

Open question: can the **local LLM string several operations together** — take
2–3 things the cloud LLM would do in one conversation and execute them
sequentially from a **task list**, not just one isolated tool call?

We have the raw material: the mined conversation archive (task 45, `src/mine/`)
contains real multi-action turns. We should extract those multi-action
conversations as multi-step candidates and see whether the local LLM can follow
the whole sequence.

## Goal

Prove (or disprove) that the local LLM can execute a **multi-step task list**:
- Take a conversation where the cloud LLM performed a small sequence (2–3
  operations, e.g. create file → read it → edit it).
- Model it as a candidate with an **ordered task list** of steps.
- Feed the task list to the local LLM and let it execute the steps **in order
  against the same sandbox**, then check the end state.

## Design options (to decide when implementing)

1. **Sequential steps reusing the existing loop.** The harness already iterates
   `candidate.steps`. A multi-step candidate is just one with 2–3 steps sharing
   one sandbox. Each step already runs a real tool. The main addition is
   ensuring steps can build on each other (step 2 operates on step 1's output).

2. **One prompt, whole task list.** Give the local LLM a single prompt: "You
   must perform these operations in order: 1) ..., 2) ..., 3) ...". Let it
   decide how to sequence the tool calls. This tests planning + execution in
   one go (harder — the 4b model must hold and order multiple steps).

3. **Hybrid.** Provide the task list as an explicit ordered list the local LLM
   must follow, but call each tool once per step (structured, less room to
   improvise). This is the most likely to succeed given the 4b model's known
   weakness at multi-arg/planning.

Recommend starting with **(3)**, then relaxing to (2) to measure how much
planning the 4b model can actually do.

## Sourcing the candidates

- Re-open the mined conversation archive (`src/mine/`, `scripts/mine-*.ts`).
- Select conversations where the cloud LLM performed a **small, self-contained
  sequence** (2–3 operations) that maps onto our confirmed single-step
  capabilities (Serena: create/read/find/insert/replace/search; LeanCTX:
  ctx_read/ctx_tree/ctx_compose).
- Curate as multi-step candidates in `test/candidates/` (agent-curated, like
  task 45 — the local LLM does NOT mine; we do).
- Each candidate gets a `pass_fail` on the **end state** (e.g. after
  "create config.json → read config.json → replace a value", check the file's
  final content), not per-step.

## Example candidate shapes

- `create hello.txt → read hello.txt → append a line` (Serena create + read +
  insert).
- `find_symbol add → get_symbols_overview → replace_content` in one file.
- `ctx_tree → ctx_read src/main.cpp → ctx_compose 'summarize'` (LeanCTX
  sequence).

## Constraints / scope

- Same rules as tasks 44–46: the local LLM only **executes**, never mines.
- Anything promoted stays `requires_review` unless the user explicitly
  approves auto-execute.
- Multi-step candidates exercise the SAME service or MIXED services (serena +
  leanctx). Mixed is the more interesting test.
- Known limitation to design around: the 4b model is weak at multi-arg calls
  with nested paths and at independent planning — so the task list should be
  explicit and the steps concrete.

## Acceptance (when implemented)

- ≥3 multi-step candidates exist in `test/candidates/`, sourced from real
  multi-action conversations.
- The harness runs a multi-step candidate and reports an end-state pass/fail.
- We know whether the local LLM can (a) execute a fixed sequential list and
  (b) plan a sequence from a task list — and at what difficulty tier it breaks.
