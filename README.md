# Cadet Token Saver

Reduce the amount of context and tool output your AI coding agent consumes — locally, and measurably.

`cadet-token-saver` is an **orchestration + measurement layer** that sits above [RTK](https://github.com/rtk-ai/rtk), [Serena](https://github.com/oraios/serena) and [LeanCTX](https://github.com/yvgude/lean-ctx). It decides **when** to compress context, runs the right tool, and records **how many tokens it saved**.

> Version 0.1.4 · MIT · Node.js 18+ · local-first operation

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
| `classify` | Classify the current request with Ollama and return the deterministic optimisation strategy |
| `optimize_context` | Classify the task, return the LeanCTX-compressed context for a file/dir |
| `find_relevant_symbols` | Serena semantic search → only the relevant symbols/files |
| `compress_command_output` | RTK-reduced output for a command |
| `chat_memory_store` | Persist / retrieve agent memories (local SQLite) — check before work, store expensive-to-rediscover facts |

The intended flow is to call `classify` once at the start of each agent turn,
then use its strategy to choose the context tools. MCP is client-driven: the
server cannot intercept every Copilot Chat message or technically force a tool
call. A workspace `AGENTS.md` can require this behavior from the agent, and
the MCP tool description reinforces it, but clients may still skip tools. Keep
the fallback path enabled for unavailable Ollama or non-compliant clients.

**From the terminal:**

```bash
cadet-token-saver wrap -- git status                # print RTK-reduced output
cadet-token-saver wrap --raw -- git status          # print the original output
cadet-token-saver wrap --shell bash -- grep -r foo  # run in git-bash (Windows)
```

> Commands run in the platform shell (`cmd.exe` on Windows) unless you pass
> `--shell <name>` (e.g. `bash` for git-bash). Compression only helps on
> large/noisy output (git status, build/test logs) — small output is pass-through.

### 3b. Save tokens with lifecycle hooks

Because the MCP server cannot force a tool call, you can install VS Code
Copilot Chat Hooks that save tokens at every point in the agent session
(mirrors Serena's hook setup, extended to all lifecycle events). One command
installs everything into the global hooks dir VS Code auto-loads from.

#### Prerequisites

- **cadet-token-saver on your `PATH`.** The hook config invokes
  `cadet-token-saver hook-*` commands, so the binary must be resolvable from the
  shell VS Code uses to run hooks. Verify with:
  ```bash
  cadet-token-saver --version
  ```
- **VS Code with agent hooks enabled.** Hooks are currently a preview feature.
  If your organization disables them, this won't take effect. You can confirm
  hooks are enabled by running the **Chat: Configure Hooks** command from the
  Command Palette, or typing `/hooks` in the chat input.

#### 1. Install all hooks (one command)

```bash
cadet-token-saver hooks find_relevant_symbols   # writes ~/.copilot/hooks/cadet-token-saver.json
```

This registers all eight lifecycle events, each wired to a `cadet-token-saver
hook-*` handler:

| Event | Handler | What it saves |
| --- | --- | --- |
| `SessionStart` | `hook-session-start` | Primes the session with memory hints + the recommended tool |
| `UserPromptSubmit` | `hook-user-prompt` | Classifies the prompt and injects the strategy deterministically |
| `PreToolUse` | `hook-redirect` + `hook-remind` | Redirects native search/list (hard-deny) and read/shell (soft-nudge) to cadet MCP tools; reminds after |
| `PostToolUse` | `hook-post-tool` | Records token-saving metrics per tool call |
| `PreCompact` | `hook-pre-compact` | Exports important context to memory before truncation |
| `SubagentStart` | `hook-subagent-start` | Classifies the subtask, injects a cheap-path primer |
| `SubagentStop` | `hook-subagent-stop` | Records nested usage, cleans up state |
| `Stop` | `hook-stop` | Persists a session summary, cleans up state |

The generated file lives at `~/.copilot/hooks/cadet-token-saver.json`. To use a
different recommended tool or write somewhere else:

```bash
cadet-token-saver hooks --tool leanctx_call --out ~/.copilot/hooks
```

#### 2. Load the hooks

VS Code auto-loads Copilot Chat Hooks from `~/.copilot/hooks/*.json`, so the
file is picked up automatically. **Reload the window** (or run **Developer:
Reload Window**) for the hooks to become active.

#### 3. Verify the hooks are active

- Open the **Output** panel and select **GitHub Copilot Chat Hooks** from the
  channel list. You should see the hooks loaded from
  `~/.copilot/hooks/cadet-token-saver.json`.
- Run **Developer: Show Agent Debug Logs** to inspect hook input/output per
  event.
- Run **View Logs** and look for a **"Load Hooks"** entry to confirm which
  locations and files were loaded.

#### How it behaves

Handlers read the hook payload from stdin and are best-effort — they never
break the agent session. The `PreToolUse` hooks steer toward the cheap cadet
MCP tools (everything flows through the token-saver MCP): `hook-redirect`
**hard-denies** raw code search and directory dumps (redirecting to
`find_relevant_symbols`), and **soft-redirects** full-file reads and noisy
shell commands (allow + a reminder to use `optimize_context` /
`compress_command_output` instead — so the agent is never blocked from
reading a file it needs to edit or running a necessary command). `hook-remind`
nudges toward the recommended tool when the agent still over-uses raw
`grep`/`read`. The `UserPromptSubmit` and `PreCompact` hooks do the heavy
token-saving: classifying each prompt and exporting context to memory before
truncation.

#### Troubleshooting

- **Hook not executing** — confirm the file is `~/.copilot/hooks/*.json`, has a
  `.json` extension, and `type: "command"` is present on each entry.
- **Permission denied / command not found** — ensure `cadet-token-saver` is on
  your `PATH` (hooks run in a shell, not the VS Code terminal). Use the full
  path to the binary if needed.
- **Timeout** — hooks default to a 30s timeout; the cadet handlers are fast, so
  a timeout usually means the binary isn't found. Increase the `timeout` field
  in the generated JSON if necessary.
- **Still not firing** — run **Chat: Configure Hooks** (or `/hooks`) to confirm
  hooks are enabled, then reload the window.

### 4. See the results

```bash
cadet-token-saver stats    # events, tokens saved, reduction %, savings by tool / task / session
```

### 5. Tell your agent how to use it

Paste this into your agent's prompts or `AGENTS.md` so it classifies every turn
and prefers the cheap paths:

> For every new user request, before doing anything else, call the Cadet Token
> Saver `classify` MCP tool once with a short, faithful restatement of the
> request (not the verbatim message); use its returned strategy and parse its
> `response_policy` and `memory_policy`. Then call `optimize_context` before
> reading a large file, `find_relevant_symbols` before broad searches, and
> `compress_command_output` for noisy command output (pass `"shell": "bash"`
> if you are in git-bash on Windows). Use `chat_memory_store` to check memory
> before starting work and to store facts that are expensive to rediscover
> (decisions, constraints, verified commands, gotchas) — never store secrets.
> If an MCP tool is unavailable, fall back to the normal operation.

---

## What it is

Cadet Token Saver is a local CLI built around one decision: **what context does this task actually need?** It classifies the task with a small local model, applies a deterministic policy, invokes the right optimisation tool, and records the result.

```
task → classify (Ollama) → policy → LeanCTX / RTK / Serena → optimised context + metrics.db
```

- **Classifier** — a local Ollama model (`qwen3:1.7b`) classifies the task (type, complexity, risk, context need) as strict JSON over HTTP. Thinking is disabled, temperature is zero, and the model is kept warm with `keep_alive` to reduce latency. If Ollama is unavailable it degrades to a conservative default instead of failing.
- **Policy engine** — deterministic: the same classification always yields the same strategy. The LLM only classifies; it never decides *how* to optimise.
- **Adapters** — RTK (output reduction), Serena (semantic navigation) and LeanCTX (context compilation) are orchestrated behind a shared interface, never reimplemented. Missing tools degrade gracefully.
- **Metrics** — every optimisation event is stored in a local SQLite database (`~/.cadet-token-saver/metrics.db`), fully offline, with estimates clearly labelled.
- **Memory** — a local SQLite memory store (`~/.cadet-token-saver/memory.db`) lets the agent persist facts that are expensive to rediscover and retrieve them across sessions via `chat_memory_store`.

### Project layout

```
src/
  cli/          the cadet-token-saver commands (init, doctor, stats, wrap, mcp, …)
  classifier/   Ollama classification + graceful degradation
  policy/       deterministic strategy engine
  integrations/ RTK / Serena / LeanCTX adapters
  metrics/      local SQLite metrics store
  memory/       local SQLite agent-memory store
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

**Status:** MVP. Wired commands: `init`, `doctor`, `stats`, `wrap`, `hooks`, `hook-remind`, `hook-session-start`, `hook-user-prompt`, `hook-post-tool`, `hook-pre-compact`, `hook-subagent-start`, `hook-subagent-stop`, `hook-stop`, `mcp`. (`config`, `dashboard`, `telemetry` remain scaffolded or partial.) The MCP server exposes `classify`, `optimize_context`, `find_relevant_symbols`, `compress_command_output`, and `chat_memory_store`.
