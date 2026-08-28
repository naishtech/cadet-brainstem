# Changelog

All notable changes to this project are documented in this file.

## [0.1.23] - 2026-08-28

### Fixed

- **Hook stdout pollution breaks classification injection** — the classifier's
  latency diagnostic (`[cadet-token-saver] classifier durations (ns) ...`) was
  written to **stdout**, so when running inside a VS Code Copilot Chat hook it
  landed before the JSON response. VS Code parses the hook's stdout as a single
  JSON object, so the leading non-JSON line caused the parse to fail and the
  whole hook output — including the injected `additionalContext` — was
  discarded. The classification therefore never reached the model. Diagnostics
  now go to **stderr** (`src/classifier/ollama.ts`), keeping stdout clean so the
  hook's JSON response parses and the steering is injected.
- **Hook timeout aborted classifier before injection** — `UserPromptSubmit` and
  `SubagentStart` hooks call the local LLM classifier (~20-45s) but used VS
  Code's 30s default hook timeout, so they were aborted before writing output.
  These hooks now set an explicit `timeout: 90000` (`src/cli/commands/hooks.ts`).

## [0.1.22] - 2026-08-28

### Changed

- **Deterministic tool/evidence synthesis (classifier architecture)** — the
  local classifier no longer asks the LLM to reason about `tool_plan` /
  `evidence_plan`. The model now produces only the lean core classification
  plus `entities` (simple noun/keyword extraction); `tool_plan`, `evidence_plan`,
  `response_policy`, and `reminders` are synthesized deterministically in code
  from a curated keyword → real-tool map (`src/classifier/synthesize.ts`).
  Synthesis is ~1ms and yields specific plans (real tool names, real entities)
  instead of the slow, generic model output observed in testing.
- **Lean classification schema** — `CLASSIFICATION_JSON_SCHEMA` reduced to
  `task/complexity/risk/context_need/entities/confidence/needs_more_context`.
  Modelfile SYSTEM and prompt templates updated to teach classification +
  entity extraction only (no tool/evidence reasoning).
- **Robust classifier auto-build** — the SessionStart auto-build now uses the
  `ollama create` CLI (with a `docker exec` fallback) and verifies the SYSTEM
  block was actually baked, instead of the HTTP `/api/create` path that silently
  dropped it (which produced a SYSTEM-less, broken classifier).

## [Unreleased]

### Changed

- **Token-saving fields first in the classification response** — reordered the
  classifier schema, the prompt shape/examples, and the MCP `classify`/
  `optimize_context` response so the cloud LLM reads the token-saving steering
  fields first: `response_policy`, `reminders`, `tool_plan`, then
  `context_need`/`task`/etc. (JSON object order is preserved for these
  consumers).

### Added

- **Reminders + multi-task (Task 37)** — `classify`/`optimize_context` now
  return:
  - `reminders` — a list of concrete, tool-anchored directives the cloud LLM
    should honor (e.g. "Use RTK for git output", "Use LeanCTX to expand shell
    output"). `guidance` is retained as a deprecated alias (derived from the
    first reminder).
  - `subtasks` — additional distinct task types detected for multi-task
    requests (e.g. "check in + push + start coding").
  - Adoption telemetry: a `recommended_tools` metrics column (migrated in
    place) records which tools the classifier recommended, surfaced in `stats`
    as "Recommended vs invoked". `optimize_context`'s tool description now
    invites both file compression and shell-output expansion/triage.

### Changed

- **`tool_plan` drops the redundant `use` array** — `tool_plan` is now
  `{ recommended_tools: [...], skip?: [...] }`. The canonical tool list is
  `recommended_tools` (each entry has `name`, `intent`, `priority`). A legacy
  flat `use` array is still accepted and folded into `recommended_tools` for
  backward compatibility. Memory-policy detection now reads `recommended_tools`.
- **Classifier latency optimization (structured output + Modelfile)** — the
  local classifier now sends a JSON Schema via Ollama's `format` parameter
  (`CLASSIFICATION_JSON_SCHEMA`) so the model emits valid structured JSON
  directly (verified: Ollama v0.32.15 accepts `additionalProperties: false`).
  Static routing instructions were moved into a Modelfile-derived model
  (`fast-classifier`, built with `ollama create fast-classifier -f Modelfile`),
  so each request sends only the user's text. Inference options are set per call
  (`temperature 0`, `num_predict 400`, `num_ctx 2048`, `keep_alive 30m`) and
  Ollama's `total_duration`/`load_duration`/`prompt_eval_duration`/
  `eval_duration` (ns) are logged so load/prefill/generation can be triaged.
- **Suppress the `node:sqlite` ExperimentalWarning** — the npm binary is now a
  CJS launcher (`bin/cadet-token-saver.cjs`) that filters the "SQLite is an
  experimental feature" warning before dynamically importing the ESM bundle
  (the warning fires during bundle instantiation, so an in-bundle patch is too
  late). Other warnings are untouched.

### Added

- **`response_policy` is now an object + recommended language standard** —
  `response_policy` was refactored from a flat list of directive keys into an
  object the cloud LLM follows when composing its reply:
  `{ directives: [...], language_standard?: "<one>" }`. The local classifier
  picks a recommended documentation language standard (ASD-STE100, Microsoft,
  Google, Diátaxis, ISO 24495, IEEE) from a fixed, validated set, nested under
  `response_policy.language_standard`. Backward-compatible: a legacy flat-array
  `response_policy` is still accepted and normalized to `{ directives }`. Taught
  in the classifier prompt and documented in `AGENTS.md` steering.
- **Metrics evaluation (Task 38, Part C)** — Evaluated LeanCTX analytics
  (`ctx_gain`/`ctx_cost`/`ctx_radar` + persisted `cost_attribution.json` /
  `savings/ledger.jsonl`): complementary to (not a replacement for) our
  `MetricsStore`. Confirmed **Serena exposes no token-usage metrics**. Spawn
  `lean-ctx mcp` with `LEAN_CTX_AGENT_ID=cadet-token-saver` so its persisted
  analytics attribute to us.
- **Shell-output routing (Task 38, Part B)** — Added `scripts/benchmark-shell-compression.ts`
  (`npm run benchmark:shell`) comparing RTK vs LeanCTX `ctx_shell` for
  command-output compression. Data-driven result: `ctx_shell` compresses better
  (avg 58% vs RTK 23% tokens saved) but is slower with a cold-start; routing
  decision applied is **"offer both"** — the classifier prompt now teaches
  shell-output tasks to recommend `compress_command_output` (RTK, fast) **and**
  `leanctx_call`/`ctx_shell` (aggressive) so the agent chooses. Added
  `leanctx_call` and `leanctx_list_tools` to the classifier `TOOL_NAMES`.
- **LeanCTX MCP proxy (Task 38, Part A)** — Expose LeanCTX's full MCP tool
  surface (`ctx_*`) to the agent the same way Serena is proxied:
  - `LeanCtxAdapter.callTool()` / `listTools()` over a persistent
    `lean-ctx mcp` stdio session (mirrors `SerenaAdapter`; cwd-based, no
    project-activation ceremony, reconnect-once on failure).
  - New MCP tools `leanctx_call` (forward any `ctx_*` tool verbatim) and
    `leanctx_list_tools` (discovery), each recording a `leanctx` metrics row.
  - `McpDeps.leanctx` widened to `Partial<LeanCtxTools>` (optimize + callTool +
    listTools + close). Verified live: `listTools` returns the exposed `ctx_*`
    tools and `ctx_tree`/`ctx_shell` calls forward successfully.
- **Response schema & guidance (Task 36)** — The classifier response now carries:
  - `guidance` — a one-line advisory summary of how to approach the request (synthesized from the task when the model omits it, so it is always non-empty).
  - `evidence_plan.prioritized_queries[]` — prioritized, source-tagged retrieval queries (`id`, `query`, `sources`, `cost_estimate`, optional `reason`/`fallback`). Replaces the older `retrieval`; `retrieval` is still returned as a legacy alias during the transition.
  - `tool_plan.recommended_tools[]` — recommended tools paired with `name`, `intent`, and 1-based `priority` (cheapest-first). Missing intents are filled from defaults; invalid entries are dropped.
  - `memory_hints` — advisory `{ use: true | false | "if_necessary" }`, never instructs to skip memory.
- Exported `RECOMMENDED_TOOL_INTENTS` and the `EvidencePlan`/`EvidenceQuery`/`RecommendedTool` types from the classifier.
- Prompt (`classifier-prompt.mustache` + default template) now teaches `guidance`, `evidence_plan`, and `recommended_tools`, with updated JSON shape and examples.
- **`classifier.derived_model` config + `CLASSIFICATION_JSON_SCHEMA`** — a new
  optional `derived_model` (default `fast-classifier`) selects the Modelfile
  classifier at runtime, falling back to the base `model`; `doctor` checks it
  with a build hint and `init` offers to build it. `createFastClassifier()`
  writes a temp Modelfile and runs `ollama create`. A committed `Modelfile` and
  `src/core/modelfile.ts` keep the static SYSTEM instructions in sync with the
  schema.

### Tests

- Added schema tests for `guidance`, `evidence_plan`, `recommended_tools`, and the legacy `retrieval` → `evidence_plan` synthesis; updated MCP `classify`/`optimize_context` tests to assert the new fields.

## [0.1.12] — 2026-08-27

### Changed

- **Classifier prompt: routing-first** — Updated the Ollama classifier prompt to be strictly routing-only (no solving or extra reasoning), JSON-only output, and to prefer the cheapest plausible retrieval strategy. Added explicit cheapest-first tie-break rules and an escalation loop (semantic search → compressed context → raw reads).
- **Response policy directives** — Added `no_unnecessary_formatting` to reduce token-heavy formatting; updated defaults and documentation to prefer compact, token-efficient downstream responses.
- **Memory opt-in** — Classifier output now supports an optional `memory` field (`{ use: boolean, reason?: string }`) and the system treats memory as optional evidence by default.
- **Tool plan guidance** — Prompt and docs now emphasize preferring MCP/semantic tools and recommending the smallest set of tools necessary.

### Added

- Task file: `tasks/35-implement-classifier-routing-prompt.md` describing implementation steps and tests.

### Tests

- Schema and tests updated to validate the `memory` field and the new response directive; local test suite passes.

### Integration

- Successfully ran the MCP end-to-end classify smoke test (`scripts/mcp-classify-e2e.ts`), confirming the MCP-exposed classifier produces routing strategies.

## [0.1.11] — 2026-08-26

### Changed

- **Classifier `context_need` is now honored** — `refineStrategy()` caps the
  task-type default by the classifier's own `context_need` (narrowing the
  strategy and downgrading `leanctx_mode`) instead of ignoring it.
- `classify` / `optimize_context` now return `confidence` + `needs_more_context`
  and a `retrieval` plan (search queries + scope).
- **Memory policy is conditional** and reworded to "optional evidence, never
  authoritative state"; `AGENTS.md` updated to match.
- `tool_plan` no longer embeds redundant per-tool `description` objects (the
  agent already has them from `tools/list`).
- `response_policy` default now includes `no_tool_narration`.

## [0.1.10] — 2026-08-26

### Added

- **Intelligence layer** — `request_id` threading through every tool +
  `assess_context` MCP tool: rebuild the context inventory from `MetricsStore`
  by `request_id` and ask the local LLM for a `continue`/`stop` verdict +
  next `tool_plan` (stateless controller step).
- **Project-scoped memory** — memories default to a cwd-derived project id
  (`resolveProjectId`: `package.json` name → git remote → `<basename>-<hash>`),
  with `__global__` for cross-project facts; `memory` CLI gains
  `--project` / `--all`.
- `postinstall` prints the installed version.

### Fixed

- Classifier no longer discards a whole classification when the local model
  emits an invalid `tool_plan` tool name or `response_policy` key (sanitised).

## [0.1.9] — 2026-08-26

### Added

- `classify` (and `optimize_context`) now return a **`tool_plan`** — an
  explicit list of tools to `use` / `skip` as `{ name, description }` objects —
  and a **split `response_policy`** — a per-task set of directive fields (e.g.
  `delta_only`, `no_filler`, `progressive_disclosure`) with descriptions,
  picked by the local classifier for each request instead of one fixed string.
- The classifier prompt now instructs the model to recommend tools
  aggressively (only when they clearly help) and to pick a minimal
  response-policy set for simple single-action requests, while research-heavy
  requests get `preserve_evidence` / `progressive_disclosure`.
- `classification` in the MCP payload is now the five core fields only
  (no duplicated raw `tool_plan` / `response_policy` keys).

## [0.1.8] — 2026-08-26

### Added

- `cadet-token-saver memory` (no subcommand) now shows memory metrics —
  database path, row count and file size (`runMemoryStats`); `memory clear`
  is unchanged.
- Steering wording tightened: the agent classifies **every user request**
  (not "every turn") with a short, faithful restatement of the request, plus
  a deterministic steering-contract test (`test/steering.test.ts`).

### Fixed

- Duplicate `[y/N]` in `stats clear` / `memory clear` prompts (`askYesNo`
  already appends it).

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
