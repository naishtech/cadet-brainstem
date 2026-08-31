# 64 — Decoupled: remove Serena gateway + proxy tools

**Status:** Planned (not yet implemented)

Part of the decoupled-architecture plan (`docs/plans/decoupled-architecture.md`).
Serena produces no token-savings metric (all events record
`estimated_tokens_saved: 0`; only hit-rate + latency tracked). Clients should
talk to Serena directly; brainstem should not proxy its API.

## Change matrix

### 1. `src/mcp/server.ts`
- Remove the gateway/proxy tools: `find_relevant_symbols`, `serena_call`,
  `serena_list_tools` — their handlers and `TOOL_DEFS` entries.

### 2. `src/integrations/serena/adapter.ts`
- Remove the adapter unless `src/procedure/` still requires it after task 62;
  if not needed, delete it.

### 3. Consumer check
- Confirm no consumers depend on calling `serena_call` / `find_relevant_symbols`
  through brainstem.

## Acceptance criteria
- No `serena_call` / `serena_list_tools` / `find_relevant_symbols` tools exposed
  by the MCP server.
- No serena proxy references remain in `src/mcp/`.
