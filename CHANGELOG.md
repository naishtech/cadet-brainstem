# Changelog

All notable changes to this project are documented in this file.

## [0.1.7] — 2026-08-26

### Added

- **Chat memory store** — a local SQLite store (`~/.cadet-token-saver/memory.db`)
  with a new `chat_memory_store` MCP tool (`store` / `update` / `get` /
  `search` / `list` / `delete`) so the agent can persist facts that are
  expensive to rediscover and retrieve them across sessions. Every operation
  records a `memory` metrics event.
- **`memory_policy`** — `classify` (and `optimize_context`) now also return a
  `memory_policy` alongside `response_policy`, steering the agent to check
  memory before starting work, store only expensive-to-rediscover facts, and
  never store secrets.
- Agent steering (AGENTS.md, `init` output, README, VS Code integration docs)
  documents the memory feature, and `stats` "Local tool calls" now includes
  `memory`.

## [0.1.6] — 2026-08-26

### Added

- **Persistent Serena session** — cadet-token-saver now spawns serena once and
  reuses the connection for the whole MCP session (auto-reconnects on
  failure), instead of starting/stopping a serena process per call. Project
  activation happens once and switches cheaply if a different project is
  passed.
- **`serena_call`** — generic passthrough that forwards any call to any Serena
  tool verbatim, so all current and future Serena tools work with no wrapper
  updates. Search convenience remains `find_relevant_symbols`.
- **`serena_list_tools`** — lists what Serena currently exposes (names +
  schemas) so the agent can discover and call any tool at runtime.
- Agent steering (AGENTS.md) tells the agent to use `serena_list_tools` +
  `serena_call` for the full Serena capability.

## [0.1.5] — 2026-08-26

### Added

- `classify` (and `optimize_context`) now return a **`response_policy`** the
  agent must parse and follow in every reply (write for another LLM: compact,
  information-dense, no decoration, filler or repeated info). Agent
  instructions (AGENTS.md, `init` output, and test-repo agent files) tell the
  agent to read and stick to it.
- Richer per-call metrics so `stats` can tell whether a tool is *working* or
  *silently failing*, not just how many tokens it saved:
  - Every event now records `degraded` (did the tool fall back / fail?), the
    tool/LLM call `latency_ms`, and a `request_id` linking a logical flow.
  - Degraded classifier (Ollama) outcomes are now recorded (marked
    `degraded`) instead of skipped — the "Local tool calls" counter still
    counts only real (non-degraded) calls, and `stats` shows the degraded
    count and average latency per tool (e.g. `ollama 12 call(s) · 2 degraded ·
    avg 2,355ms`).
  - Serena events record `symbols_found` / `files_found` so search hit-rate
    is measurable (its value is narrowing context, not byte-savings).
  - `classify` and the subsequent `optimize_context` share a `request_id`,
    so LeanCTX savings can be attributed back to the classification that
    picked the mode.
- The metrics DB migrates in place (new columns are added to existing files),
  so no manual clear is required.

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
