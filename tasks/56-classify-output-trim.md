# Task 56 — Classify output: redundancy removal

**Risk rationale:** Low — output-layer trim only; internal `Classification` type,
schema sanitizers, and deterministic synthesis are untouched.

**Status:** Not started
**Phase:** Phase 14
**Source:** `docs/plans/classify-output-trim.md` (promoted to task 56)

## Objective

Remove redundant fields from the MCP `classify` (and `optimize_context`) tool output so the
cloud LLM receives fewer tokens without losing steering information. The tool's whole
purpose is to reduce tokens sent to the cloud model, so output redundancy directly works
against the product goal.

Scope is limited to the **compiled MCP output layer only** (`src/mcp/server.ts`). The
internal `Classification` type, `src/classifier/schema.ts`, and `src/classifier/synthesize.ts`
are left intact. No change to the raw local-LLM contract (`CLASSIFICATION_JSON_SCHEMA` /
Modelfile), `assess_context` output, or the `Classification` interface.

> **Design rule:** any field derivable from another field already in the output, or any
> field that is always `null`/constant, is a candidate for removal from the tool output.

## Details

Seven redundancies to remove, applied in `src/mcp/server.ts` (`classifyTool` and
`optimizeContextTool` share the steering shape, so both change together):

1. **`guidance`** — byte-identical to `reminders[0].message`. Delete from both return
   objects; delete the now-unused `compileGuidance` helper. Internal
   `Classification.guidance` stays.
2. **`retrieval:null`** — emitted unconditionally as `null` when empty (legacy alias of
   `evidence_plan`). Convert to a conditional spread so the key is omitted when
   `compileRetrieval` returns `null`; keep the legacy field only when a real plan exists.
3. **`strategy.context_need`** — duplicates `classification.context_need` (`refineStrategy`
   copies the classifier's value). Prefer removing `context_need` from
   `OptimisationStrategy`/`PolicyEngine` (touches `src/policy/schema.ts`,
   `test/policy.test.ts`); if a smaller diff is preferred, strip it from the serialized
   strategy at return time.
4. **`evidence_plan`** — `prioritized_queries[].query` = each `entities[]` entry; `scope`
   re-encodes `entities`. Delete from output; keep `entities` as the canonical compact form.
   Delete `compileEvidencePlan` if no other caller; keep internal `EvidencePlan` type.
5. **`procedures_review`** — re-emits `triggerPattern` + full `steps` already in
   `procedures`. Slim to `{ id, triggerPattern, note }` (cloud LLM joins to `procedures` by
   `id`).
6. **`memory_policy`** — constant `MEMORY_POLICY` on every call. Emit only when it differs
   from the constant default (i.e. `classification.memory?.use === 'if_necessary'`),
   otherwise omit. Keep `memoryPolicyFor`/`MEMORY_POLICY` for `chat_memory_store` responses.
7. **`procedures[]` bookkeeping** — map matched procedures to a slim handoff shape
   (`id`, `triggerPattern`, `steps`, `riskTier`, `handoffShape`) instead of raw store
   objects; drop `keywords`, `successCount`, `failureCount`, `lastUsedAt`, `lastOutcome`,
   `source`, `createdAt`, `updatedAt`.

**Field ordering is part of the change:** `JSON.stringify` (in `handleToolCall`) preserves
key insertion order, so the cloud LLM reads the payload top-down in the order the object is
built. Re-order both return objects most-important-first:

1. `response_policy` — behavioral directives + `language_standard`
2. `tool_plan` — tools to use/skip
3. `reminders` — concrete tool-anchored directives
4. `classification` — task / complexity / risk / context_need / precision / confidence
5. `entities` — search nouns/keywords
6. `strategy` — compression / search / LeanCTX approach
7. `memory_hints` — advisory memory usage
8. `degraded` — classification quality signal
9. `llm_status` — local-LLM availability
10. `procedures` / `procedures_review` — handoff (only when present)
11. `request_id` — internal correlation id (last)

`subtasks`, `relevant_memories`, `notice`, `reason`, and `procedures_unavailable` (all
conditional) sit at their natural place among 7–11. Apply the same ordering to
`optimizeContextTool`'s shared prefix, with its tool-specific fields (`context`, `mode`,
`sourceSize`, `returnedSize`, `estimatedTokensSaved`, `note`) after the shared steering
fields and before `request_id`.

## Files

- `src/mcp/server.ts` — removals + field re-ordering in `classifyTool`/`optimizeContextTool`
- `src/policy/engine.ts`, `src/policy/schema.ts` — only for 5.3(b) `context_need` removal
- Tests: `test/mcp-server.test.ts`, `test/policy.test.ts`,
  `test/procedure-matcher.test.ts`, `test/roundtrip.test.ts`
- Docs: `docs/integration-vscode.md`, `docs/requirements.md` (if they document `classify`
  output fields)

## Test Updates

- `test/mcp-server.test.ts` — remove `guidance`, `evidence_plan`, `retrieval:null`,
  `strategy.context_need`, `memory_policy` assertions; assert they are **absent** from
  results.
- `test/policy.test.ts` — if `context_need` removed from strategy, update assertions.
- `test/procedure-matcher.test.ts` — update `procedures_review` shape
  (`id`/`triggerPattern`/`note`) and slim `procedures` fields.
- `test/roundtrip.test.ts` — update steering-field assertions.
- Add one regression test asserting the redundant keys are **not present** in the output.

## Acceptance Criteria

- [ ] `npm test` — all suites pass.
- [ ] `npm run build` (tsup) — no type errors from removed helpers/fields.
- [ ] Manual `classify` call: the seven redundancies are gone while `entities`, `reminders`,
      `tool_plan`, `response_policy` remain, and retained fields appear in the priority
      order (`response_policy` → … → `request_id`).
- [ ] `assess_context` and `chat_memory_store` outputs are unchanged.
