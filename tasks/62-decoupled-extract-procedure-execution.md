# 62 — Decoupled: extract procedure execution from gateway adapters

**Status:** Done

Part of the decoupled-architecture plan (`docs/plans/decoupled-architecture.md`).
Procedure execution now creates and closes ephemeral Serena/LeanCTX clients
when callers do not inject clients, so procedures do not depend on the
server-owned adapter singletons. The gateway still retains its shared adapters
for the legacy proxy tools covered by later decoupling tasks.

## Change matrix

### 1. `src/procedure/execute.ts` — Done
- `executeProcedure` accepts optional caller-injected clients and otherwise
  creates ephemeral Serena/LeanCTX adapters for the procedure run.
- Ephemeral clients are activated/closed within the procedure lifecycle.
- `WRITE_TOOLS` and `TOOL_ARG_HINTS` cover the Serena/LeanCTX invocation surface.

### 2. `src/procedure/schema.ts` — Done
- `PROCEDURE_SERVICES` contains only `leanctx` and `serena`.

### 3. `src/mcp/server.ts` — Done for procedure execution
- `procedure_apply` no longer passes `sharedSerena` / `sharedLeanctx` into
  `executeProcedure`; injected clients remain available for tests.
- The gateway-owned adapter lifecycle remains for the legacy proxy tools and
  will be removed with those tools in later decoupling tasks.

## Acceptance criteria
- `procedure_apply` / `procedure_review` execute serena and leanctx steps without
  requiring the server's shared adapter singletons.
- No reference to `rtk` remains in procedure schema/execution.

## Verification
- `test/procedure-execute.test.ts` verifies both services run with no injected
  clients and that the ephemeral Serena activation lifecycle is used.
