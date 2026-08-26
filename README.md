# Cadet Token Saver

Reduce the amount of context and tool output your AI coding agent consumes — locally, and measurably.

`cadet-token-saver` is an **orchestration + measurement layer** that sits above [RTK](https://github.com/rtk-ai/rtk), [Serena](https://github.com/oraios/serena) and [LeanCTX](https://github.com/yvgude/lean-ctx). It decides **when** to compress context, runs the right tool, and records **how many tokens it saved**.

> Version 0.1.0 · MIT · Node.js 18+ · works fully offline

---

## Why use it

AI coding agents send huge amounts of context to the model: full files, symbol dumps, noisy command output. Every token costs money and latency — and most of it is irrelevant to the task at hand.

Cadet Token Saver attacks that waste:

- **Compresses what you actually read** — instead of an agent reading a large file raw, it gets the LeanCTX-compressed representation (map/aggressive modes). Real tests showed ~90% size reduction on typical source files.
- **Finds only what matters** — Serena semantic search returns just the relevant symbols/files, not the whole codebase.
- **Cuts noisy command output** — RTK reduces `git status`, build logs and test output before they become context (~68% on a real `git status`).
- **Measures the savings** — every optimisation is recorded in a local store, so you can see exactly how many tokens were saved (or weren't).
- **Plays well with others** — it orchestrates battle-tested tools; it does **not** reimplement them.
- **Local and private** — no cloud, telemetry is off by default, and source code / prompts are never collected.
- **Safe by default** — degrades gracefully when a tool is missing, and never silently discards information.

---

## How to use it

### 1. Install

```bash
# from this repo (until published):
npm link

# once published:
npm i -g cadet-token-saver   # then: npx cadet-token-saver
```

Then install the integration tools — see [docs/requirements.md](docs/requirements.md): **Ollama** (with the `qwen3:1.7b` model), **RTK**, **Serena**, **LeanCTX**.

### 2. First run

```bash
cadet-token-saver init      # detect your environment, create config + metrics db
cadet-token-saver doctor    # read-only health check with actionable fixes
```

### 3. Save tokens

**From VS Code (recommended)** — register the local MCP server in `.vscode/mcp.json` (see [docs/integration-vscode.md](docs/integration-vscode.md)). Copilot Chat can then call:

| Tool | What it does |
| --- | --- |
| `optimize_context` | Classify the task, return the LeanCTX-compressed context for a file/dir |
| `find_relevant_symbols` | Serena semantic search → only the relevant symbols/files |
| `compress_command_output` | RTK-reduced output for a command |

**From the terminal:**

```bash
cadet-token-saver wrap -- git status                # print RTK-reduced output
cadet-token-saver wrap --raw -- git status          # print the original output
cadet-token-saver wrap --shell bash -- grep -r foo  # run in git-bash (Windows)
```

> Commands run in the platform shell (`cmd.exe` on Windows) unless you pass
> `--shell <name>` (e.g. `bash` for git-bash). Compression only helps on
> large/noisy output (git status, build/test logs) — small output is pass-through.

### 4. See the results

```bash
cadet-token-saver stats    # events, tokens saved, reduction %, savings by tool / task / session
```

### 5. Tell your agent how to use it

Paste this into your agent's prompts or `AGENTS.md` so it prefers the cheap paths:

> To save tokens, prefer Cadet Token Saver tools: call `optimize_context` before
> reading a large file; use `find_relevant_symbols` before broad searches; call
> `compress_command_output` for noisy command output (pass `"shell": "bash"` if
> you are in git-bash on Windows). If a tool is unavailable, fall back to the
> normal read.

---

## What it is

Cadet Token Saver is a local CLI built around one decision: **what context does this task actually need?** It classifies the task with a small local model, applies a deterministic policy, invokes the right optimisation tool, and records the result.

```
task → classify (Ollama) → policy → LeanCTX / RTK / Serena → optimised context + metrics.db
```

- **Classifier** — a local Ollama model (`qwen3:1.7b`) classifies the task (type, complexity, risk, context need) as strict JSON. If Ollama is unavailable it degrades to a conservative default instead of failing.
- **Policy engine** — deterministic: the same classification always yields the same strategy. The LLM only classifies; it never decides *how* to optimise.
- **Adapters** — RTK (output reduction), Serena (semantic navigation) and LeanCTX (context compilation) are orchestrated behind a shared interface, never reimplemented. Missing tools degrade gracefully.
- **Metrics** — every optimisation event is stored in a local SQLite database (`~/.cadet-token-saver/metrics.db`), fully offline, with estimates clearly labelled.

### Project layout

```
src/
  cli/          the cadet-token-saver commands (init, doctor, stats, wrap, mcp, …)
  classifier/   Ollama classification + graceful degradation
  policy/       deterministic strategy engine
  integrations/ RTK / Serena / LeanCTX adapters
  metrics/      local SQLite metrics store
  mcp/          local MCP server exposing the engine as tools
  config/       YAML configuration
docs/
  plans/        design document (docs/plans/initial_design.md)
  requirements.md
```

### Development

```bash
npm run build       # bundle with tsup
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
```

The project is built incrementally from the task files in `tasks/`; see the design document and the VS Code integration guide in `docs/`.

---

**Status:** MVP. Wired commands: `init`, `doctor`, `stats`, `wrap`, `mcp`. (`config`, `dashboard`, `telemetry` are scaffolded stubs.)
