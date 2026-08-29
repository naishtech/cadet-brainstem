# 47 — Procedure handoff shape: tell the cloud LLM how to ask the local LLM

**Status:** Planned (design note)
**Prerequisite:** Task 44 (procedures + `findMatches` → `procedures` handoff),
Task 46 (progressive local-LLM performance tests) — we now know which shapes the
local LLM actually handles.

## Motivation

We have measured what the local LLM **reliably does well** (see the candidate
test harness runs — tasks 45/46):

- `create_text_file` — given a **file name, extension, and content**, it creates
  a flat file at the sandbox root. Confirmed: candidate 009 (`hello.txt`),
  010 (`config.json`) — pass, repeatable.
- `read_file` — given a **relative path** (with a file listing to choose from),
  it reads an existing project file and returns real content. Confirmed:
  candidate 011 — pass, repeatable.

Right now the `classify` response returns a matched `procedures` list, but it
does **not** tell the cloud LLM *how* to phrase the handoff so the local LLM
will actually succeed. If the cloud LLM improvises the request, it may ask the
local LLM for something outside the tested shape (e.g. a nested path it can't
resolve, or an edit shape it hasn't proven), and the local LLM fails.

## Goal

When a procedure is fed back to the cloud LLM, also hand it a **handoff shape**:
an instruction that tells the cloud LLM the exact, tested way to ask the local
LLM to run the procedure — the format the local LLM handles well because we've
verified it.

Example — the classifier/procedure matcher returns, for a "create a file"
procedure:

> "If you want me to create a file, give me the file name, the extension, and
> the content in this format: `create_text_file { relative_path: <name.ext>,
> content: <text> }`. Keep the path a bare filename at the project root."

The cloud LLM then structures its request to the local LLM in exactly that
shape, instead of improvising.

## Design

1. **Store the shape with the procedure.** Extend the `procedures` table (task
   44 schema) with a `handoff_shape` column (TEXT, nullable) — a short
   instruction string the cloud LLM should pass along. For seed/curated
   procedures, fill it from the tested template (e.g. the tool's known syntax
   plus any constraints that made it pass).

2. **Return it in `classify`.** `ProcedureStore.findMatches` output (the
   `procedures` field in the `classify` response) includes each matched
   procedure's `handoff_shape` alongside its steps.

3. **Cloud LLM passes it through.** When the cloud LLM hands off, it echoes the
   `handoff_shape` instruction so the local LLM receives a request in the tested
   format. The shape is the *interface contract* between the cloud LLM and the
   local LLM for that procedure.

## Open questions / decisions to confirm

- **Where the shape lives:** a column on `procedures`, vs. derived from the
  procedure's `tool_template`/steps at match time. (A stored column is simplest
  and lets us tune the wording per-procedure; deriving avoids duplication.)
- **Granularity:** one shape per procedure, or per-step? Likely one per
  procedure is enough initially (steps share a shape).
- **Learned procedures** (`logObservedUsage`) start with no tested shape — they
  should either omit `handoff_shape` (cloud LLM falls back to improvising) or
  inherit a conservative default. Default: omit until proven.
- Whether `handoff_shape` should reference the **tested syntax** (like the
  `tool_template.syntax` used in the harness) so the cloud LLM and local LLM
  share one canonical format string.

## Acceptance (when implemented)

- A procedure can carry a `handoff_shape` string.
- The `classify` response's `procedures` entries include `handoff_shape` when
  one is set.
- Seeded procedures for the tested capabilities (`create_text_file`,
  `read_file`) carry a shape matching what made candidates 009/010/011 pass.
- `npm run typecheck`, `npm run lint`, `npm test` pass.
