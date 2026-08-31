# Decoupled Architecture — Brainstem as Steering + Procedures

## Objective

Reduce the maintenance burden of cadet-brainstem being a *gateway* (proxy) for
Serena, LeanCTX and RTK, while preserving the one thing that justifies its
existence: **real token-savings telemetry**.

The target is a standalone brainstem exposing two primary capabilities —
`steering` and `procedures` — where external tools are *measured* rather than
*proxied*.

## Current state (as-built)

| Tool | Gateway exposure (`src/mcp/server.ts`) | Real token-savings measure? |
|---|---|---|
| Serena | `find_relevant_symbols`, `serena_call`, `serena_list_tools` | ❌ No — all events record `estimated_tokens_saved: 0`; only hit-rate + latency tracked |
| LeanCTX | `leanctx_call`, `leanctx_list_tools`, `optimize_context` | ✅ Yes — `(sourceBytes - returnedBytes)/4` on `optimize_context` |
| RTK | `compress_command_output` | ⚠️ Yes in code, but **never used in practice** — `rtk` has 0 local calls; `compress_command_output` invoked 1× in 7,000 events → **dropped** |

Key coupling facts:

- `src/steering/` is **already standalone** — zero adapter dependencies.
- `src/procedure/` is **not standalone** — `PROCEDURE_SERVICES = ['leanctx', 'serena', 'rtk']`; `executeProcedure` dispatches steps into the serena/leanctx adapters.
- The **only** real savings rows come from `optimize_context` (LeanCTX). Serena's savings are always zero by construction; RTK's are structurally capable but never realized (see Decision).
- `src/metrics/` is standalone SQLite, but it only shows real numbers when fed by those gateway tools.

## Goal

Decouple brainstem so it no longer mirrors every tool's interface, but still
records genuine token savings for the tools that actually produce them.

## Decision (2026-08-31): LeanCTX-only measurement

Live `cadet-brainstem stats` evidence (7,000 events) shows RTK is effectively
unused:

```
Local tool calls:
  rtk          0 call(s)
Savings by tool:
  leanctx      9,312 tokens        # 100% of all savings
compress_command_output  recommended 106 · invoked 1
```

- `rtk` has **0 local calls**; `compress_command_output` invoked **1× in 7,000
events** despite 106 recommendations.
- **All 9,312 saved tokens come from `leanctx`** — RTK's contribution is zero.
- Conclusion: **drop RTK token-savings entirely**. The `RtkAdapter` (which runs
every command twice to compute the delta) and `compress_command_output` are
removed. Brainstem measures **LeanCTX only**.

## Target architecture

```
Client (agent / MCP host)
  │
  ├── calls  steering           (brainstem, local Ollama)
  ├── calls  procedures         (brainstem orchestration)
  ├── calls  leanctx      ── wrapped by brainstem *measurement shim* (only savings source)
  ├── calls  rtk directly     (no measurement — dropped)
  └── calls  serena directly  (no measurement; relevance only)
```

### What brainstem keeps

1. **`steering`** — unchanged. Already standalone. Local Ollama classification,
   degradation handling, response policy, tool plan, memory.
2. **`procedures`** — orchestration of steps. Steps may target serena/leanctx,
   but brainstem no longer *owns* the connection lifecycle for them.
3. **`chat_memory_store` / `activate_project` / `assess_context`** — standalone, kept.
4. **`metrics` store + dashboard** — kept, as the sink for savings telemetry.

### What changes

- **Drop the generic passthrough proxies**: `serena_call`, `serena_list_tools`,
  `leanctx_call`, `leanctx_list_tools`, `find_relevant_symbols` as gateway tools.
- **Serena**: no longer a brainstem responsibility at all. Clients talk to Serena
  directly. No savings tracking (there is none to track).
- **LeanCTX measurement shim (only)**: instead of proxying every tool, brainstem
  exposes a thin *measurement wrapper* — `optimize_context` invokes lean-ctx and
  records `estimated_tokens_saved` / `compression_ratio`, without trying to be a
  full proxy of the tool's whole API.
- **Drop RTK entirely** (`compress_command_output`): it is never used in practice
  (see Decision), so its measurement path and double-execution cost are removed.

### Measurement policy

- LeanCTX keeps the real byte-based savings measurement — the sole source of `estimated_tokens_saved`.
- RTK and Serena produce no savings metric — removed from savings dashboards/aggregation (label `n/a` rather than `0`).
- `savingsByTool`, `avgCompressionRatio`, and dashboard stats reflect only LeanCTX.

## Migration steps

1. **Extract procedure execution from the gateway adapters.**
   Move the step-dispatch in `src/procedure/execute.ts` to invoke tools directly
   (spawn `serena` / `lean-ctx` binaries, or accept a caller-injected client)
   instead of the brainstem-owned `sharedSerena` / `sharedLeanctx` singletons.
   This decouples procedure execution from the server lifecycle.

2. **Convert the LeanCTX adapter to a measurement shim; remove the RTK adapter.**
   Keep `optimize()` logic and the savings computation; drop the generic
   `callTool` passthrough surface. Register only `optimize_context`. Delete
   `RtkAdapter` and the `compress_command_output` tool + its `TOOL_DEFS` entry.

3. **Remove the Serena gateway + proxy tools.**
   Delete `serena_call`, `serena_list_tools`, `find_relevant_symbols` handlers
   and their `TOOL_DEFS` entries. Keep the Serena adapter only if procedures
   still need it; otherwise remove it.

4. **Re-point metrics.**
   Ensure `optimize_context` still writes savings rows. Make aggregation
   ignore/n/a Serena and RTK.

5. **Update docs + dashboard.**
   Reflect that brainstem measures (leanctx only) and steers/orchestrates, but
   no longer proxies serena or rtk.

## Risks / notes

- Procedures that enumerate `WRITE_TOOLS` / `TOOL_ARG_HINTS` against serena/leanctx
  tool names must be re-pointed at whatever invocation surface replaces them.
- Dropping proxy tools is a breaking change for any client that called
  `serena_call` / `leanctx_call` through brainstem. Confirm no consumers depend on
  them.
- Token-savings is leanctx only — the original motivation for brainstem survives
  in exactly that one tool. Serena was never measured; RTK was dropped.

## Out of scope (for this plan)

- Reimplementing Serena / LeanCTX / RTK.
- Cloud services.
- Changes to the steering module's internals.
