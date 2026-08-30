# Classify Output — Redundancy Removal Plan

**Status:** Draft
**Author:** cadet-brainstem engineering
**Date:** 2026-08-30
**Related:** `src/mcp/server.ts` (`classifyTool`, `optimizeContextTool`); `src/policy/engine.ts`; `src/classifier/schema.ts`; `test/mcp-server.test.ts`, `test/policy.test.ts`, `test/procedure-matcher.test.ts`, `test/roundtrip.test.ts`, `test/synthesize.test.ts`, `test/language-standard.test.ts`

---

## 1. Overview

The MCP `classify` tool returns a large steering object to the cloud LLM. Several of its
fields are **redundant**: they duplicate other fields already present, are empty `null`s,
or repeat constant boilerplate. Because the tool's whole purpose is to reduce tokens sent to
the cloud LLM, this redundancy directly works against the product goal.

This plan removes the redundant information **at the compiled MCP output layer only** — the
internal `Classification` type, the sanitizers in `src/classifier/schema.ts`, and the
deterministic synthesis in `src/classifier/synthesize.ts` are left intact. This keeps the
change low-risk: parsing, tests on the internal shape, and the procedure/memory back-ends are
unaffected. Only what the cloud LLM receives is slimmed.

> **Design rule:** any field derivable from another field already in the output, or any
> field that is always `null`/constant, is a candidate for removal from the tool output.

---

## 2. Current State (verified)

Grounded in `src/mcp/server.ts` (the exact return objects of `classifyTool` and
`optimizeContextTool`):

| # | Output field | Why redundant | Producer |
|---|---|---|---|
| 1 | `guidance` | Byte-identical to `reminders[0].message`; `compileGuidance` deliberately falls back to the first reminder | `compileGuidance` |
| 2 | `retrieval` | Emitted unconditionally as `null` when empty (legacy alias; `evidence_plan` is its replacement) | `compileRetrieval` |
| 3 | `strategy.context_need` | Duplicates `classification.context_need` | `PolicyEngine.getStrategy` |
| 4 | `evidence_plan` | `prioritized_queries[].query` = each `entities[]` entry; `scope` re-encodes `entities` | `compileEvidencePlan` |
| 5 | `procedures_review` | Re-emits `triggerPattern` + full `steps` already present in `procedures`; adds only a `note` | `compileProcedureReviews` |
| 6 | `memory_policy` | Constant `MEMORY_POLICY` string on every call (and meaningless when `memory_hints.use === false`) | `memoryPolicyFor` |
| 7 | `procedures[]` bookkeeping | `keywords`, `successCount`, `failureCount`, `lastUsedAt`, `lastOutcome`, `source`, `createdAt`, `updatedAt`, `handoffShape` are internal, not needed for handoff | raw store objects |

Both `classifyTool` and `optimizeContextTool` share the same steering-field shape, so both
must change together.

---

## 3. Goals / Non-Goals

### Goals
- Remove all seven redundancies from the `classify` (and `optimize_context`) MCP output.
- Keep the internal `Classification`/schema/synthesis layers unchanged.
- Keep `entities`, `reminders`, `tool_plan`, `response_policy` (the actual steering).
- Preserve every field still needed by procedure handoff and memory hints.
- Update all tests that assert on the removed fields.

### Non-Goals
- No change to the raw local-LLM contract (`CLASSIFICATION_JSON_SCHEMA` / Modelfile).
- No change to the `assess_context` output (different shape, not in scope).
- No restructuring of the internal `Classification` interface.
- No renaming of retained fields.

---

## 4. Removal Approach

Apply removals in `src/mcp/server.ts` inside the return objects of `classifyTool` and
`optimizeContextTool`. Where a `compile*` helper is only used for a removed field, remove or
slim the helper too. Use **conditional spread** (already the pattern in this file) so empty
or unset values are omitted rather than emitted as `null`.

**Ordering is part of the change (see §5.8):** because `JSON.stringify` (used in
`handleToolCall`) preserves object key insertion order, the order of keys in the returned
object literal *is* the order the cloud LLM reads them. The retained fields must be
re-ordered so the most important directions come first.

---

## 5. Detailed Changes

### 5.1 Remove `guidance` (field #1)
- Delete `guidance: compileGuidance(classification, args.task)` from both return objects.
- `reminders` already carries the same one-liner.
- Delete the now-unused `compileGuidance` helper (and its `task` parameter usage) from
  `classifyTool`/`optimizeContextTool`. Verify nothing else calls it.
- Note: `Classification.guidance` (internal) stays; it is only no longer surfaced.

### 5.2 Drop `retrieval` when empty (field #2)
- Change `retrieval: compileRetrieval(...)` to a conditional spread so the key is omitted
  when `compileRetrieval` returns `null`:
  ```ts
  ...(compileRetrieval(classification.retrieval) !== null
    ? { retrieval: compileRetrieval(classification.retrieval) }
    : {}),
  ```
- Keep the legacy field for back-compat when a real plan exists; the default empty case now
  emits nothing instead of `null`.

### 5.3 Drop `strategy.context_need` (field #3)
- `strategy.context_need` is always equal to `classification.context_need` (the policy engine
  copies the classifier's value; see `refineStrategy` in `src/policy/engine.ts`).
- In the output, either:
  - **(a)** strip `context_need` from the serialized strategy when returning it, or
  - **(b)** remove `context_need` from the `OptimisationStrategy` type and `PolicyEngine` —
    the strategy consumers (`optimizeContextTool`) only read `strategy.leanctx_mode`.
- Recommend **(b)** for a permanent fix, but it touches `src/policy/schema.ts` and
  `test/policy.test.ts`. If a smaller diff is preferred, do **(a)**.

### 5.4 Remove `evidence_plan` from output (field #4)
- Delete `evidence_plan: compileEvidencePlan(...)` from both return objects.
- `entities` remains and is the canonical, compact form the cloud LLM uses; the per-query
  `sources`/`scope` wrapper adds tokens without new information.
- Keep `compileEvidencePlan` internally? It is only used by these two return objects — delete
  it if no other caller exists. Keep the internal `EvidencePlan` type (used by
  `parseClassification` and `synthesizePlans`).

### 5.5 Slim `procedures_review` (field #5)
- Change `compileProcedureReviews` to emit only `{ id, triggerPattern, note }` (drop the
  duplicated `steps`):
  ```ts
  return procedures
    .filter((p) => p.riskTier === 'requires_review' || p.steps.some((s) => isWriteStep(s)))
    .map((p) => ({
      id: p.id,
      triggerPattern: p.triggerPattern,
      note: 'Mutates the repo. Do NOT auto-execute — present the proposed change for user approval before running (review gate).',
    }));
  ```
- The cloud LLM can join to the full steps via `procedures` by `id`.

### 5.6 Omit `memory_policy` when not using memory (field #6)
- In `classifyTool`/`optimizeContextTool`, emit `memory_policy` only when it differs from the
  always-constant default. Simplest: emit only when
  `classification.memory?.use === 'if_necessary'` (the only non-constant branch of
  `memoryPolicyFor`), otherwise omit it — the cloud LLM already holds the static policy in
  its system prompt.
- Keep `memoryPolicyFor`/`MEMORY_POLICY` for the `chat_memory_store` tool responses (they
  legitimately return the policy).

### 5.7 Trim `procedures[]` bookkeeping (field #7)
- In `classifyTool`, map the matched procedures to a slim handoff shape before returning
  (instead of returning raw store objects):
  ```ts
  procedures = store.findMatches(classification.entities, args.task);
  ...
  procedures: procedures.map((p) => ({
    id: p.id,
    triggerPattern: p.triggerPattern,
    steps: p.steps,
    riskTier: p.riskTier,
    handoffShape: p.handoffShape,
  })),
  ```
- Keep `keywords` only if procedure matching/display needs it; by default drop it with the
  other bookkeeping fields. `successCount`/`failureCount`/`lastUsedAt`/`lastOutcome`/
  `source`/`createdAt`/`updatedAt` are not needed for the handoff.

### 5.8 Prioritize field order — most important directions first

`JSON.stringify` (in `handleToolCall`) preserves key insertion order, so the cloud LLM reads
the payload **top-down in the order the object is built**. Order the return object of
`classifyTool` and `optimizeContextTool` by descending importance to the cloud LLM:

**Recommended final field order (both tools):**

1. `response_policy` — behavioral directives + `language_standard` (how to compose the reply)
2. `tool_plan` — tools to use/skip (the immediate next action)
3. `reminders` — concrete tool-anchored directives
4. `classification` — task / complexity / risk / context_need / precision / confidence
5. `entities` — search nouns/keywords
6. `strategy` — compression / search / LeanCTX approach
7. `memory_hints` — advisory memory usage
8. `degraded` — classification quality signal
9. `llm_status` — local-LLM availability
10. `procedures` / `procedures_review` — handoff (only when present)
11. `request_id` — internal correlation id (last)

**Rationale:** directives and action-steering that change the cloud LLM's behaviour and next
steps come first (1–3); the task understanding that guides retrieval (4–6) follows;
operational status and handoff plumbing (7–11) are last. This keeps the highest-signal tokens
earliest in the context window. `subtasks`, `relevant_memories`, `notice`, `reason`, and
`procedures_unavailable` (all conditional) sit at their natural place among 7–11.

Apply the same ordering to `optimizeContextTool`'s shared prefix, with its tool-specific
fields (`context`, `mode`, `sourceSize`, `returnedSize`, `estimatedTokensSaved`, `note`)
placed after the shared steering fields and before `request_id`.

---

## 6. Test Updates

Update assertions that reference removed/trimmed fields:

| File | Change |
|---|---|
| `test/mcp-server.test.ts` | Remove `guidance`, `evidence_plan`, `retrieval:null`, `strategy.context_need`, `memory_policy` assertions; assert they are **absent** from `classify`/`optimize_context` results |
| `test/policy.test.ts` | If 5.3(b), remove `strategy.context_need` assertions and `refineStrategy` context_need expectations |
| `test/procedure-matcher.test.ts` | Update `procedures_review` shape assertions (now `id`/`triggerPattern`/`note`) and slim `procedures` fields |
| `test/roundtrip.test.ts` | Update steering-field assertions in the classify result |
| `test/synthesize.test.ts` | Only if internal synthesis output changed (should be none) |
| `test/language-standard.test.ts` | Only if `response_policy` handling changed (should be none) |

Add one regression test asserting the redundant keys are **not present** in the output.

---

## 7. Docs to Update

- `docs/integration-vscode.md` and `docs/requirements.md`: if they document the `classify`
  output fields, remove the deleted fields and note the new slim shape.
- `AGENTS.md` / `docs/plans/*` references to `guidance`, `evidence_plan`, or
  `strategy.context_need` in the classify output.
- `Modelfile`: no change (raw model contract unchanged).

---

## 8. Rollout / Verification

1. Implement 5.1–5.8 in `src/mcp/server.ts` (+ `src/policy/*` for 5.3).
2. Update tests per §6.
3. Run `npm test` (or the repo's test command) — all suites must pass.
4. Run `npm run build` (tsup) — confirm no type errors from removed helpers/fields.
5. Manually call `classify` (e.g. `cadet-brainstem wrap -- classify` or the MCP tool) and
   diff the output against the pre-change shape to confirm each of the seven redundancies is
   gone while `entities`, `reminders`, `tool_plan`, `response_policy` remain, and that the
   retained fields appear in the §5.8 priority order (`response_policy` → … → `request_id`).
6. Confirm `assess_context` and `chat_memory_store` outputs are unchanged.

**Expected outcome:** the `classify` payload drops the redundant `guidance`, empty
`retrieval:null`, `strategy.context_need`, the `evidence_plan` block, the duplicated
`procedures_review.steps`, the constant `memory_policy`, and the `procedures` bookkeeping —
reducing tokens sent to the cloud LLM without losing steering information. The retained
fields are re-ordered most-important-first so the cloud LLM reads the highest-signal
directions (`response_policy`, `tool_plan`, `reminders`) before task context and status
plumbing.
