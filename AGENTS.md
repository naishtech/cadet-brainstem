# Cadet Token Saver — agent instructions

Cadet Token Saver reduces the amount of context and tool output sent to the
model. It is available as a **local MCP server** (`cadet-token-saver mcp`,
registered in `.vscode/mcp.json`) and as a **command wrapper**
(`cadet-token-saver wrap`). Use the cheap paths below whenever possible.

## Classify every turn

- At the start of every turn, always call the `classify` MCP tool with the
  user's request. It runs the local LLM and returns the recommended `strategy`
  (LeanCTX mode, compression, search approach). Use that strategy to decide
  how to use the tools below.
- Parse the returned `response_policy` and follow it in every reply: write for
  another LLM (compact, information-dense, no decoration, filler or repeated
  info), since your response may become future LLM context.
- Parse the returned `memory_policy` and follow it too: check memory before
  starting work, and store expensive-to-rediscover facts when done.
- If `classify` is unavailable, continue with the tools below using defaults —
  never block on it.

This instruction guides the agent; MCP itself cannot force a client to invoke a
tool for every chat message.

## Memory

- `classify` returns a `memory_policy` alongside `response_policy`. Check
  `chat_memory_store` before starting work and prefer retrieving over
  re-deriving facts that are expensive to rediscover.
- Store facts that are expensive to rediscover: decisions, constraints,
  verified commands, and gotchas. Never store secrets or credentials.
- At the end of every response, review the conversation you just had and store
  any memories that match the policy via `chat_memory_store`
  (`action: "store"`), scoping with `project` and `tags` where useful.

## Context reads (MCP tools)

- Before reading a **large file**, call the `optimize_context` MCP tool with the
  current task and the file path. It returns the LeanCTX-compressed
  representation (map/aggressive modes) instead of the raw file.
- Before dumping a directory or broad search results, call the
  `find_relevant_symbols` MCP tool with a symbol/path pattern and the project
  directory. Read only the returned files/symbols.
- For the **full** Serena capability (rename, referencing symbols, diagnostics,
  edits, etc.), call `serena_list_tools` once to see what Serena currently
  exposes, then `serena_call` to invoke any of them (forwarded verbatim). New
  Serena tools work automatically — no hardcoded list.
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
