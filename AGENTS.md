# Cadet Brainstem — agent instructions

Cadet Brainstem reduces the amount of context and tool output sent to the
model. It is available as a **local MCP server** (`cadet-brainstem mcp`,
registered in `.vscode/mcp.json`) and as a **command wrapper**
(`cadet-brainstem wrap`). Use the cheap paths below whenever possible.

## Steer every user request

- For each new user request, before taking any other action (no other tool
  calls, no file reads), call the `steering` MCP tool exactly once. Pass a
  short, faithful restatement of the request — what the user wants done, in
  one or two sentences — not the verbatim message.
- Use the returned `strategy` (LeanCTX mode, compression, search approach)
  and `tool_plan.recommended_tools` (prioritized tool recommendations with
  intent) to decide how to use the tools below for the rest of that request.
- Honor the returned `reminders` (short tool-anchored directives, e.g. "Use
  LeanCTX for context optimization") and any `subtasks`
  (additional detected task types).
- The returned `response_policy` is an object the cloud LLM must follow when
  composing its reply: `directives` (per-task behavioral directives, e.g.
  `delta_only`, `no_filler`, `no_tool_narration`) and an optional
  `language_standard` (a documentation style guide to write in). Follow every
  directive and the chosen language standard in your reply.
- Parse the returned `memory_policy` and follow it too: treat memory as
  optional evidence, never authoritative state — retrieve hints before work,
  verify them against the current project, and store expensive-to-rediscover
  facts when done.
- If `steering` is unavailable, continue with the tools below using defaults —
  never block on it.

This instruction guides the agent; MCP itself cannot force a client to invoke a
tool for every user request.

## Memory

- `steering` returns a `memory_policy` alongside `response_policy`. Treat
  memory as **optional evidence, never authoritative state**: retrieve hints
  before work and verify them against the current project state before acting.
  Skip `chat_memory_store` entirely when the returned `tool_plan` skips it.
- Store facts that are expensive to rediscover: decisions, constraints,
  verified commands, and gotchas. Never store secrets or credentials.
- Memories are scoped to the current project by default. Pass `project` to
  override, or `project: "__global__"` for facts shared across projects.
- At the end of every response, review the conversation you just had and store
  any memories that match the policy via `chat_memory_store`
  (`action: "store"`), scoping with `project` and `tags` where useful.

## Context reads (MCP tools)

- Before reading a **large file**, call the `optimize_context` MCP tool with the
  current task and the file path. It returns the LeanCTX-compressed
  representation (map/aggressive modes) instead of the raw file.
- Use Serena's native MCP server directly for semantic navigation and broad
  search when needed.
- Use Serena's native MCP server directly for semantic navigation, rename,
  references, diagnostics, and edits.
- Use `optimize_context` when noisy command output needs concise context.
- Thread one `request_id` through the tools in a logical flow (reuse the id
  `steering` returns). After gathering context, call `assess_context` with
  that id to ask whether the signal is sufficient and what to gather next.

## Command output (wrapper)

- For noisy commands (git status, ls, test output), prefer running them through
  the wrapper:
  ```
  cadet-brainstem wrap -- <command>
  ```
  It runs the command through the normal shell.

## Rules

- If a task requires exact/raw content, read it directly — never discard
  information the user needs.
- All tools degrade gracefully: if a tool is unavailable, fall back to the
  original behaviour.
