# VS Code integration

How to use Cadet Token Saver from VS Code to reduce agent token usage.

## Prerequisites

1. Make `cadet-token-saver` available on your PATH:
   - from this repo: `npm link` (creates the global command), or
   - once published: `npm i -g cadet-token-saver`.
2. Install the integration tools — see `docs/requirements.md`
   (Ollama + model, RTK, LeanCTX, Serena).

## 1. Register the MCP server (Copilot Chat)

`.vscode/mcp.json` registers `cadet-token-saver mcp`. Open the workspace and
the **cadet-token-saver** MCP server appears in Copilot Chat's tools. The agent
can then call:

- `optimize_context` — classify the task, return the LeanCTX-compressed
  representation of a file/directory.
- `find_relevant_symbols` — Serena semantic search for task-relevant symbols.
- `compress_command_output` — RTK-reduced output for a command.

Verify it works by running `cadet-token-saver mcp` in a terminal (it stays
running until the client disconnects).

## 2. Steer the agent

`AGENTS.md` (repo root) tells the agent to prefer `optimize_context` /
`find_relevant_symbols` for large context reads and `wrap` for noisy commands.
Copy the relevant section into your own project's `AGENTS.md`.

## 3. Use `wrap` from a VS Code task

`.vscode/tasks.json` ships runnable tasks — `Ctrl+Shift+P` → **Tasks: Run Task**:

- `cadet: init` — first-run setup
- `cadet: doctor` — environment health check
- `cadet: stats` — metrics summary
- `cadet: wrap (git status)` — `cadet-token-saver wrap -- git status`

Or run manually in the integrated terminal:

```
cadet-token-saver wrap -- git status
cadet-token-saver wrap --raw -- git status
cadet-token-saver wrap --shell bash -- grep -r foo
```

> Commands run in the platform shell (`cmd.exe` on Windows) unless you pass
> `--shell <name>` (e.g. `bash` for git-bash). Compression only helps on
> large/noisy output — small output is pass-through (0 tokens saved). The
> command is passed through as-is (it is not validated).

## Users of other repos

Copy `.vscode/mcp.json` (and the relevant `AGENTS.md` section / task) into your
own repo, and ensure `cadet-token-saver` is installed and on your PATH.
