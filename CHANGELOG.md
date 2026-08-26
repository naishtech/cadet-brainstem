# Changelog

All notable changes to this project are documented in this file.

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
