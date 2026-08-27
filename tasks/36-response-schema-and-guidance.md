## 36 — Response schema: evidence plan & guidance

Goal
----
Implement the improved classifier response schema and the short `guidance` summary so the local classifier produces clear, actionable, non-authoritative steering for the orchestrator and cloud LLM.

What to implement
------------------
- Add the `guidance` one-line advisory string to the classifier response (local LLM generates it from the task).
- Rename and formalize `retrieval` → `evidence_plan` (prioritized, source-tagged queries).
- Ensure `tool_plan` pairs recommended tools with an `intent` and `priority`.
- Keep `memory_hints` advisory and include shallow hits as `relevant_memories` (optional).
- Update MCP server to expose these fields in the `classify` tool response and to log the plan.
- Add unit & integration tests that assert the new fields exist and are well-formed.

Templates
---------

Guidance (one-line) templates the local LLM should follow:
- Compare tasks: "Advisory: compare all function overrides between <A> and <B>, focusing on <X>; orchestrator may use Serena, RTK, or LeanCtx to fetch code and evidence — verify facts before concluding."
- Search tasks: "Advisory: find references to <symbol> across the project (semantic + text search); use Serena first, fall back to RTK grep if needed."
- Summarize tasks: "Advisory: summarize recent changes affecting <area>; prefer LeanCtx extraction of relevant files, and include short examples."

Evidence Plan entry template (JSON example):

```
{
  "id": "q1",
  "query": "BP_Koala function overrides",
  "reason": "Find canonical overrides in reference blueprint",
  "sources": ["serena","file_search"],
  "cost_estimate": "cheap",
  "fallback": ["q2"]
}
```

ToolPlan entry template:

```
{
  "name": "serena",
  "intent": "semantic search for blueprint function overrides",
  "priority": 1,
  "constraints": ["max_results:10"]
}
```

Acceptance criteria
-------------------
- `classify` responses include `guidance` (non-empty short string).
- `classify` responses include `evidence_plan.prioritized_queries[]` with `query`, `sources`, and `id`.
- `tool_plan.recommended_tools[]` entries contain `name`, `intent`, and `priority`.
- `memory_hints.use` is present and never instructs to 'skip' memory — only `true|false|'if_necessary'`.
- Unit tests added/updated to validate schema and serializer/deserializer.
- MCP smoke test updated to assert presence of `guidance` and `evidence_plan` (optional for now).

Files likely to change
----------------------
- `src/classifier/schema.ts` — add types for `guidance`, `evidence_plan`, and `tool_plan` improvements.
- `src/classifier/ollama.ts` / `classifier-prompt.mustache` — instruct the local LLM to emit `guidance` and `evidence_plan` entries.
- `src/mcp/server.ts` — include `guidance` and `evidence_plan` in the `classify` response and wire orchestration to use them.
- `test/*.test.ts` — update or add `classify` response tests (e.g., `test/classify-memory.test.ts`, `test/mcp-server.test.ts`).

Implementation notes
--------------------
- Keep `guidance` short (one sentence) and derived from the task string and classification intent.
- Treat `evidence_plan` queries as orchestration directives — the orchestrator decides how to execute each query across adapters.
- Provide cost hints so the orchestrator can do cheapest-first retrieval.
- Ensure backward compatibility: include previous `retrieval` field as an alias for a transition period.

Follow-up
---------
- After implementation, update `docs/initial_design.md` and relevant task docs (e.g., `tasks/25-mcp-server.md`) to document the new behavior.
- Optionally produce a JSON Schema file under `src/classifier/schema.json` for strict validation.

Checklist
---------
- [x] Add schema types and validators
- [x] Update classifier prompt and local LLM examples
- [x] Return `guidance` and `evidence_plan` from MCP `classify` tool
- [x] Add unit + smoke tests
- [x] Update docs and changelog

**Status:** Implemented (pending review/commit). Tests: 220 passing / 21 files. Build, typecheck, and lint green.

### Implementation notes
- `guidance` is always non-empty in MCP responses — synthesized from the task when the model omits it (`compileGuidance`).
- `evidence_plan.prioritized_queries[]` carries `id`/`query`/`sources` (+ optional `reason`/`cost_estimate`/`fallback`); `retrieval` remains as a legacy alias (`compileEvidencePlan` falls back to it).
- `tool_plan.recommended_tools[]` pairs each tool with `name`/`intent`/`priority`; missing intents are filled from `RECOMMENDED_TOOL_INTENTS`, invalid names dropped.
- `memory_hints` exposes `classification.memory` as `{ use, reason? }` and never instructs to skip memory.
