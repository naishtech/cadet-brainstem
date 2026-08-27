# 40 — `tool_plan` drops the redundant `use` array

**Status:** Implemented (ad-hoc refinement, uncommitted at time of writing)

Record of the `tool_plan` cleanup: the flat `use` array was redundant with
`recommended_tools` and has been removed.

## Before / after
```json
// before
"tool_plan": { "use": ["optimize_context"], "recommended_tools": [{...}] }
// after
"tool_plan": { "recommended_tools": [{ "name": "optimize_context", "intent": "...", "priority": 1 }] }
```

## Details
- `ToolPlan` is now `{ recommended_tools?: RecommendedTool[], skip?: ToolName[] }`.
- `recommended_tools` (name + intent + priority) is the single source of truth
  for which tools to use.
- Backward compatibility: `sanitizeToolPlan` folds a legacy flat `use` array
  into `recommended_tools` (so old classifier output still works).
- Memory-policy detection now checks `recommended_tools` names
  (`toolPlanUses(plan, 'chat_memory_store')`).
- Prompt (mustache + default template + examples), `AGENTS.md`, conservative
  defaults, and tests updated to the new shape.

## Validation
Build, typecheck, lint green; test suite green.
