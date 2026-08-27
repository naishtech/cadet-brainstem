## 35 — Implement classifier prompt: routing-first & policy updates

Objective

Implement the classifier prompt and related documentation changes described in the recent review so the local classifier becomes a routing-only, cheap-first signal layer.

Scope

- Update the classifier prompt template to explicitly be a routing-only JSON-only classifier.
- Replace the "safer, higher option" rule with a "prefer the cheapest plausible retrieval" principle.
- Add `no_unnecessary_formatting` to `response_policy` and document its use.
- Make `memory` opt-in in the classifier JSON and document `memory` field semantics.
- Add explicit escalation loop guidance (cheap → semantic search → compressed read → raw read).
- Prefer MCP/semantic tools in `tool_plan` and recommend fewer tools by default.
- Add updated examples demonstrating routing-first decisions.
- Update tests and JSON schema validation for the classifier output.

Deliverables

- Edit `src/classifier/classifier-prompt.mustache` to implement the routing-first prompt.
- Add/modify unit tests under `test/` verifying the JSON shape and sample classifications.
- Update `docs/plans/initial_design.md` to reflect the new routing-first classifier guidance.
- Add examples in `src/classifier/examples/` (or update existing examples) showing expected JSON outputs.
- Update any relevant README or docs that reference classifier behaviour.

Checklist

- [ ] Modify `classifier-prompt.mustache` to enforce: JSON-only, routing-only, no solving, no invented facts, cheapest-first tie-breaks, memory opt-in, `no_unnecessary_formatting`.
- [ ] Add 3 new examples in the prompt/tests showing question, coding_new, debug with routing-first tool_plans.
- [ ] Update JSON schema used for validation and tests to include `memory` (optional) and `response_policy` directive `no_unnecessary_formatting`.
- [ ] Run or add tests: `test/classifier.test.ts` (or similar) to validate output and confidence thresholds.
- [ ] Document escalation loop in `docs/` and `docs/plans/initial_design.md`.
- [ ] Notify maintainers / open PR with changes (manual step).

Notes

Keep changes minimal and backwards-compatible: if another part of the system expects the previous shape, make `memory` optional and preserve existing fields. Prefer conservative changes to avoid breaking MCP consumers.
