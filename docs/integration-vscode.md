# VS Code integration

How to use Cadet Brainstem from VS Code to reduce agent token usage.

## Prerequisites

1. Make `cadet-brainstem` available on your PATH:
   - from this repo: `npm link` (creates the global command), or
   - once published: `npm i -g cadet-brainstem`.
2. Install the integration tools — see `docs/requirements.md`
  (Ollama + model, LeanCTX, Serena).

## 1. Register the MCP server (Copilot Chat)

`.vscode/mcp.json` registers `cadet-brainstem mcp`. Open the workspace and
the **cadet-brainstem** MCP server appears in Copilot Chat's tools. The agent
can then call:

- `steering` — steering the current user request with the local Ollama model
   and return the deterministic optimisation strategy. Call this first.
- `optimize_context` — steering the task, return the LeanCTX-compressed
  representation of a file/directory.
- `chat_memory_store` — persist / retrieve agent memories (local SQLite):
  check before starting work, store facts that are expensive to rediscover.

Verify it works by running `cadet-brainstem mcp` in a terminal (it stays
running until the client disconnects).

## 2. Steer the agent

`AGENTS.md` (repo root) tells the agent to call `steering` at the start of
every turn, then prefer `optimize_context` for large
context reads and noisy commands. It also tells the agent to check
`chat_memory_store` before starting work and, at the end of each response, to
review the conversation and store memories that match the `memory_policy` —
facts that are expensive to rediscover (decisions, constraints, verified
commands, gotchas), never secrets. Copy the relevant section into your own
project's `AGENTS.md`.

This is an instruction-level preference, not a protocol guarantee. Copilot
Chat decides whether to call an MCP tool; the MCP server cannot intercept or
reject a user message that arrives without a tool call. For guaranteed
steering, put the steering step in a wrapper or gateway that
owns the chat request before it reaches the model. The built-in fallback keeps
normal operation available when Ollama or MCP is unavailable.

## 3. Use `wrap` from a VS Code task

`.vscode/tasks.json` ships runnable tasks — `Ctrl+Shift+P` → **Tasks: Run Task**:

- `cadet: init` — first-run setup
- `cadet: doctor` — environment health check
- `cadet: stats` — metrics summary
- `cadet: wrap (git status)` — `cadet-brainstem wrap -- git status`

Or run manually in the integrated terminal:

```
cadet-brainstem wrap -- git status
cadet-brainstem wrap --raw -- git status
cadet-brainstem wrap --shell bash -- grep -r foo
```

> Commands run in the platform shell (`cmd.exe` on Windows) unless you pass
> `--shell <name>` (e.g. `bash` for git-bash). Compression only helps on
> large/noisy output — small output is pass-through (0 tokens saved). The
> command is passed through as-is (it is not validated).

## 4. Hooks (Copilot Chat PreToolUse)

`.vscode/copilot-hooks.json` registers PreToolUse hooks that run in the agent
loop (this file is local/untracked — copy it into your repo):

- **`remind`** — when the agent makes many consecutive raw code-search/read
  calls (`Bash`, `grep_search`, `read_file`), deny with a nudge to use
  `optimize_context` instead:
  `cadet-brainstem hook-remind --tool optimize_context`
- **`procedure-review`** — while a matched `requires_review` procedure is
  active, deny direct native writes so the agent must use the review flow.
  Also deny `procedure_apply` without a matching, unexpired review token and
  explicit `approved: true`; read-only tools and the procedure MCP calls pass
  through:
  `cadet-brainstem hook-procedure-review`

The write-review flow is: `steering` flags a write procedure →
`procedure_review {procedure_id, repo, args}` shows the diff and returns a
short-lived `review_token` → user approves the exact reviewed change →
`procedure_apply {procedure_id, repo, args, review_token, approved: true}`
applies it. The server binds the token to the procedure, repository, and exact
arguments, and rejects replayed or mismatched approvals.

## Users of other repos

Copy `.vscode/mcp.json` (and the relevant `AGENTS.md` section / task) into your
own repo, and ensure `cadet-brainstem` is installed and on your PATH.
