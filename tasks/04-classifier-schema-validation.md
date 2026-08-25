# Task 04 — Classifier JSON Schema Validation

**Risk rationale:** Part of the classifier risk — guards against malformed/unreliable LLM output; cheap insurance that the riskiest assumption is actually being validated.

**Status:** Not started
**Phase:** Phase 2
**Source:** `docs/plans/initial_design.md` — §3 Local LLM classifier ("The output must be validated against a JSON schema")

## Objective

Define and enforce the JSON schema for classifier output and validate model responses against it.

## Details

- Define a typed schema for the classifier result (task, complexity, risk, context_need, precision — all enums from Task 03).
- Use a schema validation library (e.g. `zod`) to validate the raw LLM response.
- On invalid/malformed output (missing fields, bad enum values, non-JSON), the classifier result is rejected.
- Invalid output must not crash the pipeline — it should trigger the conservative default fallback (see Task 05).
- Keep the schema in one place so the policy engine (Task 07) consumes the same validated type.

## Acceptance Criteria

- [ ] Schema covers all five enum fields from the design doc.
- [ ] Valid JSON responses pass validation.
- [ ] Invalid responses (bad enums, missing fields, non-JSON) are rejected cleanly.
- [ ] Rejection path feeds into the conservative default fallback.
- [ ] Shared validated type used by both classifier and policy engine.
