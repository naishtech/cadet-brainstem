# Changelog

All notable changes to this project are documented in this file.

## [0.1.3] — 2026-08-26

### Added

- `stats` now shows a **Local tool calls** section listing the number of
  recorded calls per tool (`ollama`, `rtk`, `serena`, `leanctx`; missing tools
  default to 0).
- The local context-LLM (classifier) call made by the `optimize_context` MCP
  tool is now recorded as an `ollama` event, so it shows up in the per-tool
  call counts — but only when the classifier actually ran (a degraded,
  fallback classification is not counted as a local LLM call).

## [0.1.2] — 2026-08-26

### Added

- `compress_command_output` (MCP) and `wrap` now accept a `shell` option
  (`--shell <name>` for `wrap`) so commands can run in a chosen shell — pass
  `"bash"` on Windows to use git-bash instead of the default `cmd.exe`.
- When no tokens are saved (small/already-compact output), the tool now says so
  explicitly instead of silently returning the same size.

### Changed

- `init` now ends with a "tell your agent how to use it" snippet, and the
  README/integration docs document the shell behaviour and the
  small-output-expectation (compression only helps on large/noisy output).

## [0.1.1] — 2026-08-26

### Fixed

- `init` no longer prompts to pull the classifier model when it is already
  present (it checks the Ollama API first, like `doctor`).

### Added

- `init` prints a bold coloured banner and, after setup, the
  `.vscode/mcp.json` snippet to connect your IDE to the MCP server.

## [0.1.0] — 2026-08-26

Initial MVP release.

### Added

- Local CLI: `init`, `doctor`, `stats`, `wrap`, `mcp`
  (`config`, `dashboard`, `telemetry` are scaffolded stubs).
- Ollama classifier (`qwen3:1.7b`) with strict JSON output and graceful
  degradation to a conservative default.
- Deterministic policy engine mapping classification → optimisation strategy.
- RTK (output reduction), Serena (semantic navigation) and LeanCTX (context
  compilation) adapters — orchestrated, never reimplemented.
- Local SQLite metrics store with `stats` terminal summaries.
- Local MCP server exposing `optimize_context`, `find_relevant_symbols` and
  `compress_command_output`.
- VS Code integration: `.vscode/mcp.json`, runnable tasks, and `AGENTS.md`
  agent steering.
- Config, requirements, integration and design documentation.
