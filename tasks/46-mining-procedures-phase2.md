# 45 — Mine procedures from conversation history — Phase 2: seed/eval split and matcher accuracy testing

**Status:** Planned (not yet implemented)
**Phase:** Two-phase effort (Phase 2 = this task; Phase 1 = task 45)
**Prerequisite:** Phase 1 (task 45) completed and the candidate batch **human-approved** for promotion. Also requires the live `procedures` table and `ProcedureStore.findMatches` (task 44).

## Goal

Take the human-approved candidate set from Phase 1, split it into a **seed set**
(promoted into the live `procedures` table) and a **held-out eval set**, then
build a matcher-accuracy script to measure whether the seed set actually matches
real requests. Produce a comparison table and a precision/recall-style summary
for manual review.

## Scope & hard constraints

- **Only proceed after Phase 1's output is reviewed and a batch approved for
  promotion.** Do not auto-promote.
- Split the **approved candidates**, not the full raw conversation set.
- Mined data starts conservative: seed entries are tagged
  `source: "mined_from_history"` and their `risk_tier` defaults to
  `"requires_review"` — **never** default any mined procedure to
  `auto_execute` without explicit user confirmation.
- The eval set is held out and **not** written into the live `procedures` table.
- This task must not touch the memory service or its data (same constraint as
  task 45).

## Prerequisites / dependencies

- Phase 1 (task 45) complete and approved.
- The live `procedures` table and `ProcedureStore.findMatches` are referenced
  as "built earlier". **They do not currently exist in `src/`** (verified: no
  `procedures` / `ProcedureStore` / `findMatches` symbols). `findMatches` and
  the `procedures` schema must exist before Step 2.2 can run — build them first
  if they are not present.

## Deliverables

### 1. Step 2.1 — Split into seed set and held-out eval set (`mine split`)

Split the approved candidates:
- **Seed set** (majority): promote into the live `procedures` table, tagged
  `source: "mined_from_history"`, with `risk_tier` defaulted to
  `"requires_review"` **regardless** of what the extraction step suggested
  (mined data starts conservative, same as `learned_from_usage` entries). Do
  not default anything to `auto_execute` without explicit user confirmation.
- **Eval set** (held-out portion): kept **separate**, **not** written into the
  live `procedures` table. This set represents real requests we can test
  matching against.
- Split method: **chronological** (e.g. most recent N weeks of approved
  candidates), or a **random sample** if timestamps are unreliable.
- Report the split sizes and the method used.

### 2. Step 2.2 — Matcher accuracy script (`mine evaluate`)

Using `ProcedureStore.findMatches` (prerequisite), run each eval-set candidate's
original request text (or its extracted entities, if that is what is available)
through the same entity-extraction + matching pipeline used in production. For
each eval item record:
- Did it match any seeded procedure?
- If yes, was it the **correct** match (i.e. does the matched procedure's steps
  look like what actually happened in that conversation)? Because "correct"
  requires judgment, produce a **human-reviewable comparison table** rather than
  fully automated scoring:
  - eval request → matched procedure → actual steps taken.
- Clearly flag **false positives** (matched something wrong) and **false
  negatives** (should have matched, didn't).

### 3. Step 2.3 — Summary report

- A precision/recall-style summary **if judgeable automatically**, plus the
  full comparison table for manual review.
- This determines whether the seed set is good enough to trust, or needs
  another round of curation before being relied on for any auto-execute
  behavior.

### 4. CLI wiring

- Add `cadet-brainstem mine split` and `cadet-brainstem mine evaluate`
  subcommands, registered in `src/cli/commands.ts`.
- Update `test/cli.test.ts` command list.
- Tests: `test/mine-split.test.ts`, `test/mine-evaluate.test.ts`.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- `mine split` reports split sizes + method; seed entries carry
  `source: "mined_from_history"` and `risk_tier: "requires_review"`; eval set is
  held out and never written to the live table.
- `mine evaluate` produces the comparison table (eval request → matched
  procedure → actual steps) and flags false positives / false negatives.
- `mine evaluate` emits a precision/recall summary where auto-judgeable.
- Nothing is promoted or defaulted to `auto_execute` without explicit user
  approval.
