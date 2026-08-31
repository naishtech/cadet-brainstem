# 63 — Decoupled: LeanCTX measurement shim; remove RTK adapter

**Status:** Planned (not yet implemented)

Part of the decoupled-architecture plan (`docs/plans/decoupled-architecture.md`).
Brainstem should not be a full proxy of LeanCTX — only a thin measurement
wrapper. RTK is dropped entirely (evidence: `rtk` has 0 local calls;
`compress_command_output` invoked 1× in 7,000 events; all 9,312 saved tokens
come from `leanctx`).

## Change matrix

### 1. `src/integrations/leanctx/adapter.ts`
- Keep `optimize()` and the savings computation
  (`Math.max(0, Math.round((sourceBytes - returnedBytes) / 4))`).
- Drop the generic `callTool` passthrough surface used by `leanctx_call`.

### 2. Delete the RTK adapter
- Remove `src/integrations/rtk/adapter.ts` (`RtkAdapter`, which runs each command
  twice to compute `tokensBefore - tokensAfter`).

### 3. `src/mcp/server.ts`
- Keep only `optimize_context` (steering + LeanCTX `.optimize()`).
- Remove `leanctx_call`, `leanctx_list_tools`, `compress_command_output` tools
  and their `TOOL_DEFS` entries / handlers.
- Remove the `sharedRtk` instance and its lifecycle.

## Acceptance criteria
- `optimize_context` still records `estimated_tokens_saved` / `compression_ratio`.
- No `rtk` / `compress_command_output` references remain in `src/`.
