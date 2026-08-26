# Changelog

All notable changes to this project are documented in this file.

## [0.1.4] — 2026-08-26

### Added

- New **`classify`** MCP tool: run the local LLM on the user request and get
  the recommended optimisation strategy (LeanCTX mode, compression, search
  approach). The agent instructions (AGENTS.md / `init` output) now tell the
  agent to **always classify the request first** so the local LLM actually
  runs and the right strategy is picked before using the other tools.
- Doc links in the CLI output (init, stats, adapter hints) now point to the
  full GitHub URLs instead of relative paths.

### Fixed

- The local classifier (Ollama) kept timing out (and silently degrading to the
  conservative default) because `qwen3:1.7b` can take ~10s to load from cold
  on CPU, over the old 10s budget — so `stats` showed `ollama 0 call(s)`.
  - The classifier now sends `keep_alive` (`30m` by default) so the model
    stays loaded between calls, keeping classify latency ~3-4s.
  - The timeout is raised to 30s by default and is now configurable via
    `classifier.timeout_ms` (and `classifier.keep_alive`) in the config file.

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
