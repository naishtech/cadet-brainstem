# 62 — Decoupled: extract procedure execution from gateway adapters

**Status:** Planned (not yet implemented)

Part of the decoupled-architecture plan (`docs/plans/decoupled-architecture.md`).
Today `executeProcedure` runs steps by dispatching into the brainstem-owned
Serena/LeanCTX adapters (`sharedSerena` / `sharedLeanctx` singletons owned by
`src/mcp/server.ts`). This couples procedure execution to the gateway/server
lifecycle. Decouple it so procedures can run without the server owning the
connections.

## Change matrix

### 1. `src/procedure/execute.ts`
- `executeProcedure` currently injects `serena: { callTool }` /
  `leanctx: { callTool }` via the `invoke()` function and dispatches steps into
  those adapters.
- Change the invocation surface to talk to the tools directly (spawn the
  `serena` / `lean-ctx` binaries itself) or accept a caller-injected client,
  instead of the server-owned singletons.
- Re-point `WRITE_TOOLS` and `TOOL_ARG_HINTS` enumerations to the new invocation
  surface.

### 2. `src/procedure/schema.ts`
- `PROCEDURE_SERVICES = ['leanctx', 'serena', 'rtk']` — remove `'rtk'` (RTK is
  dropped by the plan; see task 63).

### 3. `src/mcp/server.ts`
- Stop passing `sharedSerena` / `sharedLeanctx` into `executeProcedure`.
- `runMcpServer` teardown (`resolved.serena.close?.()`) and the persistent
  session lifecycle become moot once the server no longer owns the adapters.

## Acceptance criteria
- `procedure_apply` / `procedure_review` execute serena and leanctx steps without
  requiring the server's shared adapter singletons.
- No reference to `rtk` remains in procedure schema/execution.
