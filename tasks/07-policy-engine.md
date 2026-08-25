# Task 07 — Policy Engine

**Risk rationale:** Strategy validity (success criterion #2) — deterministic, but the mapping decides real-world outcomes; verified before wiring real tools.

**Status:** Not started
**Phase:** Phase 3
**Source:** `docs/plans/initial_design.md` — §4 Policy engine

## Objective

Implement a deterministic policy engine that converts a classifier result into an optimisation strategy.

## Details

- The LLM classifies; the policy engine decides. The LLM must never directly execute tools or construct shell commands.
- The engine is **deterministic** — same classification always yields the same strategy.
- Example policies from the design doc:

```
DEBUG:
  context_need: broad
  compression: conservative
  code_search: semantic
  terminal_output: error-focused

CODING_NEW:
  context_need: targeted
  compression: normal
  code_search: semantic

QUESTION:
  context_need: minimal
  compression: aggressive

REFACTOR:
  context_need: structural
  compression: normal
  code_search: semantic
```

- Store policies in **configuration** (extend the Task 02 config schema with a `policies` section) rather than scattering them in code, with sensible defaults.
- The strategy output should include the fields the adapters need: compression level, code_search mode, terminal_output mode, and a LeanCTX mode/budget mapping (for Task 08).
- Provide a default/conservative strategy used by the Task 05 fallback.

## Acceptance Criteria

- [ ] Same classification input always produces the same strategy output.
- [ ] Policies for all task types are defined (at minimum debug, coding_new, coding_fix, question, refactor; extend to all 13 task types).
- [ ] Policies live in config with defaults, not scattered in code.
- [ ] LLM result feeds in; strategy feeds out; no command execution from the LLM path.
- [ ] Conservative default strategy exists for the fallback path.
