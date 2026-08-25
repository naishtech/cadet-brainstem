# Task 05 — Classifier Graceful Degradation

**Risk rationale:** Part of the classifier risk — proves the system still works (conservatively) when Ollama is missing, never silently (safety principles §14).

**Status:** Not started
**Phase:** Phase 2
**Source:** `docs/plans/initial_design.md` — §3 Local LLM classifier ("If Ollama is unavailable, the system should degrade gracefully and use a conservative default policy. Do not silently fail.")

## Objective

Implement fallback behaviour when Ollama is unavailable or returns invalid output.

## Details

- When Ollama is unavailable (not installed, not running, connection failure, timeout), the classifier must:
  - Not crash.
  - Not silently pretend it classified successfully.
  - Return/use a **conservative default policy**.
- The conservative default should bias toward the highest-context, lowest-risk classification so no information is lost (aligns with safety principles §14).
- Surface the fallback clearly: log/warn that classification fell back to defaults and why.
- Reuse the same degradation path for invalid schema output from Task 04.

## Acceptance Criteria

- [ ] Ollama down → no crash, conservative default policy applied.
- [ ] Invalid/unschema'd output → same conservative fallback.
- [ ] Fallback is explicit (warned/logged), never silent.
- [ ] Fallback conservatively preserves context rather than discarding it.
