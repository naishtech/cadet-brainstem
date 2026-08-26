# Task 29 — Chat Memory Store: MCP endpoint + response policy

**Risk rationale:** The agent-facing surface — makes memory usable from any MCP
client and steers the agent via a new response-policy field.

**Status:** Implemented on branch `task/29-31-chat-memory-store` (pending review/commit)
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §17 Chat memory store

## Objective

Expose `chat_memory_store` as an MCP tool (create / update / retrieve / delete
memories) and add a `memory_policy` field to the `classify` response policy so
the agent knows to check and write memory.

## Details

- New MCP tool `chat_memory_store` with an `action` argument:
  `store | update | get | search | list | delete`, plus validated per-action
  params (`content`, `id`, `query`, `tags`, `project`).
- `src/mcp/server.ts`:
  - `ChatMemoryArgs` + `chatMemoryStoreTool()` handler dispatching to the
    `MemoryStore` (new `McpDeps.memory` dependency, defaulting to a live
    `MemoryStore`).
  - Register the tool in `TOOL_DEFS` + dispatch + exports in `src/mcp/index.ts`.
  - Graceful degradation: any failure returns a clear error, never throws
    uncaught (safety §14).
- Metrics: every operation records an `OptimisationEvent` (tool: `memory`,
  operation: the action, `degraded`, `latency_ms`, `request_id`).
- Response policy: add a **`memory_policy`** constant (sibling of
  `RESPONSE_POLICY`) and return it from `classifyTool` and `optimizeContextTool`
  alongside `response_policy`. Wording along the lines of: check
  `chat_memory_store` before starting work; store facts that are expensive to
  rediscover (decisions, constraints, verified commands, gotchas); never store
  secrets; prefer retrieving over re-deriving.

## Acceptance Criteria

- [x] `chat_memory_store` exposes the six actions with validated arguments.
- [x] store → search → get → update → delete round-trips through the tool.
- [x] `classify` and `optimize_context` return `memory_policy`.
- [x] Each operation records a `memory` metrics event (verify with `stats`).
- [x] Degrades gracefully when the memory store is unavailable.
- [x] Tests in `test/mcp-server.test.ts` (tool) + a `memory` event assertion.
