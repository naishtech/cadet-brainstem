# Cadet Token Saver — agent instructions

Cadet Token Saver reduces the amount of context and tool output sent to the
model. It is available as a **local MCP server** (`cadet-token-saver mcp`,
registered in `.vscode/mcp.json`) and as a **command wrapper**
(`cadet-token-saver wrap`). Use the cheap paths below whenever possible.

## Context reads (MCP tools)

- Before reading a **large file**, call the `optimize_context` MCP tool with the
  current task and the file path. It returns the LeanCTX-compressed
  representation (map/aggressive modes) instead of the raw file.
- Before dumping a directory or broad search results, call the
  `find_relevant_symbols` MCP tool with a symbol/path pattern and the project
  directory. Read only the returned files/symbols.
- If you need noisy command output as context, call `compress_command_output`
  with the command instead of pasting raw terminal output.

## Command output (wrapper)

- For noisy commands (git status, ls, test output), prefer running them through
  the wrapper:
  ```
  cadet-token-saver wrap -- <command>
  ```
  It prints the RTK-reduced output. Use `--raw` to see the original.

## Rules

- If a task requires exact/raw content, read it directly — never discard
  information the user needs.
- All tools degrade gracefully: if a tool is unavailable, fall back to the
  original behaviour.
