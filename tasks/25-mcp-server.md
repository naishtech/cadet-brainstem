# Task 25 — Local MCP Server

**Risk rationale:** Highest-leverage integration point for VS Code — proves the engine is callable by real agents (Copilot Chat / any MCP client) and is the primary way the tool actually reduces token usage.

**Status:** Implemented on branch `task/25-mcp-server` (pending review/commit)
**Phase:** Phase 11
**Source:** `docs/plans/initial_design.md` — §16 Integration & interception (VS Code)

## Objective

Expose the existing engine (classifier → policy → LeanCTX / RTK / Serena → metrics) as a **local MCP server** so VS Code Copilot Chat and any MCP-capable agent can call it for optimised context instead of raw reads.

## Details

- New command: `cadet-token-saver mcp` (stdio MCP server).
- Use the official `@modelcontextprotocol/sdk` (already a dependency, used by the Serena adapter).
- Expose tools that wrap the existing modules — do **not** reimplement the tools:
  - `optimize_context` — classify the task (Ollama, with conservative fallback) → policy → LeanCTX-compressed representation of a file/directory.
  - `find_relevant_symbols` — Serena `find_symbol` (with project activation) for task-relevant symbols.
  - `compress_command_output` — RTK reduction of a command's output.
- Every tool records an `OptimisationEvent` in the metrics store (Task 06).
- Graceful degradation: any tool failure returns a clear error and falls back to the original behaviour (safety principles §14).
- Never execute arbitrary commands from the LLM — tools take explicit, validated arguments.
- Register the server so VS Code can find it (see Task 27).

## Acceptance Criteria

- [x] `cadet-token-saver mcp` starts a stdio MCP server exposing the three tools.
- [x] Each tool delegates to the existing classifier/policy/adapters (no reimplementation).
- [x] Tool calls record metrics rows (verify with `stats`).
- [x] Degrades gracefully when Ollama/RTK/Serena/LeanCTX is unavailable.
- [x] The LLM cannot construct arbitrary commands (fixed, validated tool schemas).
