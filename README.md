# Cadet Brainstem

Reduce the amount of context and tool output your AI coding agent consumes — locally, and measurably.

`cadet-brainstem` is a local **steering + procedure layer** with LeanCTX-backed context measurement. It decides when context needs attention and records how many tokens LeanCTX saves.

> Version 0.2.0 · MIT · Node.js 18+ · local-first operation

---

## Why use it

AI coding agents send huge amounts of context to the model: full files, symbol dumps, noisy command output. Every token costs money and latency — and most of it is irrelevant to the task at hand.

Cadet Brainstem attacks that waste:

- **Compresses what you actually read** — instead of an agent reading a large file raw, it gets the LeanCTX-compressed representation (map/aggressive modes). Real tests showed ~90% size reduction on typical source files.
- **Keeps workflows focused** — procedures turn recurring repository work into reviewable, approval-gated actions.
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
npm i -g cadet-brainstem   # then: npx cadet-brainstem
```

Then install the integration tools — see [docs/requirements.md](docs/requirements.md): **Ollama** (with the `qwen3:4b` model), **Serena**, and **LeanCTX**.

### 2. First run

```bash
cadet-brainstem init      # detect your environment, create config + metrics db
cadet-brainstem doctor    # read-only health check with actionable fixes
```

### 3. Save tokens

**From VS Code (recommended)** — register the local MCP server in `.vscode/mcp.json` (see [docs/integration-vscode.md](docs/integration-vscode.md)). Copilot Chat can then call:

| Tool | What it does |
| --- | --- |
| `steering` | Steering the current request with Ollama and return the deterministic optimisation strategy |
| `optimize_context` | Steering the task, return the LeanCTX-compressed context for a file/dir |
| `chat_memory_store` | Persist / retrieve agent memories (local SQLite) — check before work, store expensive-to-rediscover facts |
| `activate_project` | Set the active project so memory and procedures are scoped to it |
| `assess_context` | Ask whether the context gathered so far is sufficient and what to gather next |
| `procedure_review` | Build a concrete, reviewable diff for a write-procedure step before it applies |
| `procedure_apply` | Execute a procedure step against a real repo — write steps are gated behind approval |

The intended flow is to call `steering` once at the start of each agent turn,
then use its strategy to choose the context tools. MCP is client-driven: the
server cannot intercept every Copilot Chat message or technically force a tool
call. A workspace `AGENTS.md` can require this behavior from the agent, and
the MCP tool description reinforces it, but clients may still skip tools. Keep
the fallback path enabled for unavailable Ollama or non-compliant clients.

Manage the rest of the stack from the CLI:

```bash
cadet-brainstem init        # first-run setup (config + integrations + db)
cadet-brainstem doctor      # read-only health check with actionable fixes
cadet-brainstem stats       # saved/processed token metrics (clear to wipe)
cadet-brainstem memory      # show/manage agent memories (per-project or --global)
cadet-brainstem procedure   # list procedures; run/review one against a repo
cadet-brainstem mine        # mine conversations for procedure candidates
cadet-brainstem hooks --pretool   # install VS Code Copilot Chat Hooks
cadet-brainstem mcp         # run the local MCP server
```

### 3b. Save tokens with lifecycle hooks

Because the MCP server cannot force a tool call, you can install VS Code
Copilot Chat Hooks that save tokens at every point in the agent session
(mirrors Serena's hook setup, extended to all lifecycle events). One command
installs everything into the global hooks dir VS Code auto-loads from.

#### Prerequisites

- **cadet-brainstem on your `PATH`.** The hook config invokes
  `cadet-brainstem hook-*` commands, so the binary must be resolvable from the
  shell VS Code uses to run hooks. Verify with:
  ```bash
  cadet-brainstem --version
  ```
- **VS Code with agent hooks enabled.** Hooks are currently a preview feature.
  If your organization disables them, this won't take effect. You can confirm
  hooks are enabled by running the **Chat: Configure Hooks** command from the
  Command Palette, or typing `/hooks` in the chat input.

#### 1. Install all hooks (one command)

```bash
cadet-brainstem hooks --pretool   # writes ~/.copilot/hooks/cadet-brainstem.json
```

This registers every lifecycle event, each wired to a `cadet-brainstem hook-*`
handler. The procedure review gate is always enabled; the broader redirect and
reminder hooks remain **opt-in** via `--pretool` because they intercept every
tool call and proved too intrusive for daily dev:

| Event | Handler | What it saves |
| --- | --- | --- |
| `SessionStart` | `hook-session-start` | Primes the session with memory hints + the recommended tool |
| `UserPromptSubmit` | `hook-user-prompt` | Classifies the prompt and injects the strategy deterministically |
| `PreToolUse` | `hook-procedure-review` | Denies write `procedure_apply` without a matching review token and explicit approval |
| `PreToolUse` *(opt-in)* | `hook-redirect` + `hook-remind` | Redirects native search/list (hard-deny) and read/shell (soft-nudge) to cadet MCP tools; reminds after |
| `PostToolUse` | `hook-post-tool` | Records token-saving metrics per tool call |
| `PreCompact` | `hook-pre-compact` | Exports important context to memory before truncation |
| `SubagentStart` | `hook-subagent-start` | Classifies the subtask, injects a cheap-path primer |
| `SubagentStop` | `hook-subagent-stop` | Records nested usage, cleans up state |
| `Stop` | `hook-stop` | Persists a session summary, cleans up state |

The generated file lives at `~/.copilot/hooks/cadet-brainstem.json`. To use a
different recommended tool or write somewhere else:

```bash
cadet-brainstem hooks --tool optimize_context --out ~/.copilot/hooks
```

#### 2. Load the hooks

VS Code auto-loads Copilot Chat Hooks from `~/.copilot/hooks/*.json`, so the
file is picked up automatically. **Reload the window** (or run **Developer:
Reload Window**) for the hooks to become active.

#### 3. Verify the hooks are active

- Open the **Output** panel and select **GitHub Copilot Chat Hooks** from the
  channel list. You should see the hooks loaded from
  `~/.copilot/hooks/cadet-brainstem.json`.
- Run **Developer: Show Agent Debug Logs** to inspect hook input/output per
  event.
- Run **View Logs** and look for a **"Load Hooks"** entry to confirm which
  locations and files were loaded.

#### How it behaves

Handlers read the hook payload from stdin and are best-effort — they never
break the agent session. The `PreToolUse` hooks steer toward the cheap cadet
MCP tools (everything flows through the brainstem MCP): `hook-redirect`
**hard-denies** raw code search and directory dumps (redirecting to
`optimize_context`), and **soft-redirects** full-file reads and noisy
shell commands (allow + a reminder to use `optimize_context` instead — so the agent is never blocked from
reading a file it needs to edit or running a necessary command). `hook-remind`
nudges toward the recommended tool when the agent still over-uses raw
`grep`/`read`. `hook-procedure-review` denies write `procedure_apply` unless the
call carries an unexpired server-issued review token bound to the exact
procedure, repository, and arguments, plus `approved:true`; it surfaces the
concrete diff so a human can review a write before it lands. The
`UserPromptSubmit` and `PreCompact` hooks do the heavy token-saving: classifying
each prompt and exporting context to memory.
before truncation.

#### Troubleshooting

- **Hook not executing** — confirm the file is `~/.copilot/hooks/*.json`, has a
  `.json` extension, and `type: "command"` is present on each entry.
- **Permission denied / command not found** — ensure `cadet-brainstem` is on
  your `PATH` (hooks run in a shell, not the VS Code terminal). Use the full
  path to the binary if needed.
- **Timeout** — hooks default to a 30s timeout; the cadet handlers are fast, so
  a timeout usually means the binary isn't found. Increase the `timeout` field
  in the generated JSON if necessary.
- **Still not firing** — run **Chat: Configure Hooks** (or `/hooks`) to confirm
  hooks are enabled, then reload the window.

### 4. See the results

```bash
cadet-brainstem stats    # events, tokens saved, reduction %, savings by tool / task / session
```

### 5. Tell your agent how to use it

Paste this into your agent's prompts or `AGENTS.md` so it classifies every turn
and prefers the cheap paths:

> For every new user request, before doing anything else, call the Cadet Brainstem
> Saver `steering` MCP tool once with a short, faithful restatement of the
> request (not the verbatim message); use its returned strategy and parse its
> `response_policy` and `memory_policy`. Then call `optimize_context` before
> reading a large file or analyzing noisy command output. Use `chat_memory_store` to check memory
> before starting work and to store facts that are expensive to rediscover
> (decisions, constraints, verified commands, gotchas) — never store secrets.
> For reusable or write work, use `procedure_review` to see the diff and
> `procedure_apply` (with approval) to execute. If an MCP tool is unavailable,
> fall back to the normal operation.

---

## What it is

Cadet Brainstem is a local CLI built around one decision: **what context does this task actually need?** It classifies the task with a small local model, applies a deterministic policy, invokes the right optimisation tool, and records the result.

```
task → steering (Ollama) → policy → LeanCTX → optimised context + metrics.db
```

- **Steering** — a local Ollama model (`qwen3:4b`) classifies the task (type, complexity, risk, context need) as strict JSON over HTTP. Thinking is disabled, temperature is zero, and the model is kept warm with `keep_alive` to reduce latency. If Ollama is unavailable it degrades to a conservative default instead of failing.
- **Policy engine** — deterministic: the same steering always yields the same strategy. The LLM only classifies; it never decides *how* to optimise.
- **Integrations** — LeanCTX provides context compilation and measurement; clients can use Serena directly for semantic navigation. Missing tools degrade gracefully.
- **Procedures** — reusable, intent-grounded operation sequences (`service: leanctx | serena`, tool, args) that the local model can execute against a real repo on the cloud agent's behalf. Read-only steps run automatically; write steps are gated behind a reviewable diff and explicit approval (`procedure_review` → `procedure_apply`). New candidates are discovered by mining historical conversations (`mine`).
- **Metrics** — every optimisation event is stored in a local SQLite database (`~/.cadet-brainstem/metrics.db`), fully offline, with estimates clearly labelled.
- **Memory** — a local SQLite memory store (`~/.cadet-brainstem/memory.db`) lets the agent persist facts that are expensive to rediscover and retrieve them across sessions via `chat_memory_store`, scoped per project (`activate_project`).

### What the local LLM does

The local LLM is a **routing steering**, not a code generator. It reads a short restatement of the request and answers one question: *what does this task need?* Its job is steering and entity extraction only — it never decides how to optimise, and it never invokes tools.

For each request it returns, as strict JSON:

- **Task type** — one of 13 types (question, coding_new, coding_fix, debug, refactor, test, review, architecture, documentation, investigation, planning, search, configuration).
- **Complexity** — low, medium, or high.
- **Risk** — low, medium, or high.
- **Context need** — minimal, targeted, broad, or exhaustive.
- **Entities** — the key nouns and keywords pulled from the request (for example "checkout page", "blueprint", "X300").
- **Confidence** — how sure the model is of this steering.
- **Needs more context** — true only when the request is insufficient on its own.

The output is deterministic and cheap: temperature is zero, thinking is disabled, and the JSON schema is enforced by the caller. The steering feeds the **policy engine**, which deterministically maps it to the token-saving strategy (LeanCTX mode, search approach, compression). Because the model only classifies, it stays small, fast, and low-cost.

The same model also powers supporting tasks:

- **`assess_context`** — decides whether the context gathered so far is sufficient, or what to gather next.
- **Procedure mining** — extracts reusable, repeatable operation sequences from past conversations (`mine`).
- **Curated procedures** — lets you run basic, repeatable tasks from the procedure store (for example read a file, or create-then-edit a file). Read-only steps run automatically; write steps are gated behind a reviewable diff and explicit approval (`procedure_review` → `procedure_apply`).

If Ollama is unavailable, the system degrades to conservative defaults instead of failing. The steering then returns a safe, generic steering and the rest of the pipeline continues normally.

### Project layout

```
src/
  cli/          the cadet-brainstem commands (init, doctor, stats, mcp, …)
  steering/   Ollama steering + graceful degradation
  policy/       deterministic strategy engine
  integrations/ Serena / LeanCTX adapters
  metrics/      local SQLite metrics store
  memory/       local SQLite agent-memory store
  mcp/          local MCP server exposing the engine as tools
  mine/         mine historical conversations for procedure candidates
  procedure/    reusable procedure store + execution/review bridge
  config/       YAML configuration
docs/
  plans/        design documents
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

**Status.** Wired commands: `init`, `doctor`, `stats`, `memory`, `mine`,
`procedure`, `hooks`, `hook-remind`, `hook-procedure-review`, `hook-redirect`,
`hook-session-start`, `hook-user-prompt`, `hook-post-tool`, `hook-pre-compact`,
`hook-subagent-start`, `hook-subagent-stop`, `hook-stop`, `mcp`.
(`config`, `dashboard`, `telemetry` remain scaffolded or partial.) The MCP
server exposes `steering`, `optimize_context`, `chat_memory_store`, `activate_project`,
`assess_context`, `procedure_review`, and `procedure_apply`.
