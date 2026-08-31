# Task 60 — SPIKE: local LLM manages the todo list

**Status:** Not started (spike / investigation)
**Phase:** Phase 15
**Source:** observation from the Unreal (Covyne/Bloodstone) conversation — the cloud LLM
called `manage_todo_list` and tracked progress in-context.

## Objective

Investigate offloading the **todo list** (`manage_todo_list`) to the **local LLM** instead of
the cloud LLM. The local model already steers each request (task, entities, tool_plan); it
could also maintain the task breakdown / progress list, emitting `manage_todo_list` updates so
the cloud model doesn't burn context tokens on bookkeeping.

## Why (evidence)

In the Bloodstone doc session the cloud LLM repeatedly called `manage_todo_list` (Created 5
todos, then 2/6, 4/5...), tracking multi-slice progress in its own context. That is cheap,
mechanical bookkeeping the local model could own.

## Spike questions

1. Where does `manage_todo_list` come from and how is it invoked? (Cloud model tool vs an MCP
   tool the local model could emit.)
2. Can the local model produce todo items/updates (from the steering `task` + `entities`) and
   have them applied without the cloud model? What's the delivery path — a hook (PostToolUse/
   UserPromptSubmit) or a new MCP tool?
3. Latency/cost: does a todo-update steer call add meaningful overhead vs the cloud tokens saved?
4. Interaction with the existing `hook-redirect`/`hook-remind` PreToolUse hooks and the steering
   `tool_plan` — where does todo emission best fit?

## Deliverables

- A spike write-up: recommended design (local-LLM-owned todos), the delivery mechanism, and
  any new hook/MCP surface.
- A go/no-go recommendation on whether to implement.

## Acceptance Criteria

- [ ] Spike documents the current `manage_todo_list` flow (cloud-side) and a local-LLM design.
- [ ] Identifies the exact delivery mechanism (hook vs MCP tool vs steering field).
- [ ] Gives a latency/cost estimate and a go/no-go recommendation.
