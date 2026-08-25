# Task 03 — Ollama Classifier

**Risk rationale:** RISKIEST ASSUMPTION — a small local Ollama model reliably returns valid structured JSON classifications (success criterion #1). If this fails, every downstream decision is built on sand.

**Status:** Implemented on branch `task/03-ollama-classifier` (pending review/commit)
**Phase:** Phase 2
**Source:** `docs/plans/initial_design.md` — §3 Local LLM classifier

## Objective

Implement the local classifier that sends the user's current task/message to a small local Ollama model and requires structured JSON output.

## Details

- Provider: Ollama (configurable via `classifier.provider: ollama`).
- Model: configurable via `classifier.model` — do NOT hard-code a model name.
- Must NOT use keyword matching (no `if message.includes("debug")` style logic).
- The classifier prompt must explicitly tell the model:
  - classify only
  - do not solve the user's task
  - return JSON only
  - do not invent information
  - prefer conservative classifications when uncertain

## Classifier output schema

```
task:
  question | coding_new | coding_fix | debug | refactor | test |
  review | architecture | documentation | investigation | planning |
  search | configuration

complexity:
  low | medium | high

risk:
  low | medium | high

context_need:
  minimal | targeted | broad | exhaustive

precision:
  approximate | normal | exact
```

- Output must be validated against a JSON schema (see Task 04).
- The classifier must never execute commands or construct shell commands (safety principle §14.4).
- Interface lives in `src/classifier/`.

## Acceptance Criteria

- [ ] Sends task text to the configured Ollama model.
- [ ] Requests and parses structured JSON matching the schema.
- [ ] Model name comes from config, not code.
- [ ] No keyword-matching classification anywhere.
- [ ] Classifier prompt enforces the five constraints listed above.
- [ ] Never executes or constructs commands.
