# 41 — `stats`: savings by tool/task only where > 0

**Status:** Implemented (ad-hoc refinement; released in v0.1.17)

Record of the `stats` cleanup. `getSavingsByTool()` / `getSavingsByTaskType()`
were grouping **every** tool/task by `SUM(estimated_tokens_saved)`, which
polluted the view with meaningless `0 tokens` rows for non-compression tools
(`ollama`/`memory`/`serena` — these record `0` savings by design; only `leanctx`
and `rtk` compress).

## Change
- `groupedSavings` now adds `HAVING COALESCE(SUM(estimated_tokens_saved), 0) > 0`,
  so only rows with actual savings appear.
- `stats` prints a helpful note when no compression savings exist yet:
  `(none recorded yet — use compress_command_output / optimize_context ...)`.
- Per-tool activity (calls / degraded / latency) remains in the separate
  "Local tool calls" section.
- Updated the `mcp-server.test.ts` serena case (serena now absent from
  savings-by-tool, since it records hit-rate not token savings).

## Validation
Build, typecheck, lint green; test suite green.
