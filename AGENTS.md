# Cadet Token Saver — agent instructions

Cadet Token Saver reduces the amount of context and tool output sent to the
model. It is available as a **local MCP server** (`cadet-token-saver mcp`,
registered in `.vscode/mcp.json`) and as a **command wrapper**
(`cadet-token-saver wrap`). Use the cheap paths below whenever possible.

## Classify every user request

- For each new user request, before taking any other action (no other tool
  calls, no file reads), call the `classify` MCP tool exactly once. Pass a
  short, faithful restatement of the request — what the user wants done, in
  one or two sentences — not the verbatim message.
- Use the returned `strategy` (LeanCTX mode, compression, search approach)
  and `tool_plan` (tools to use / skip) to decide how to use the tools below
  for the rest of that request.
- The returned `response_policy` is a set of per-task directives (e.g.
  `delta_only`, `no_filler`, `no_tool_narration`). Follow every directive
  given in your reply.
- Parse the returned `memory_policy` and follow it too: check memory before
  starting work, and store expensive-to-rediscover facts when done.
- If `classify` is unavailable, continue with the tools below using defaults —
  never block on it.

This instruction guides the agent; MCP itself cannot force a client to invoke a
tool for every user request.

## Memory

- `classify` returns a `memory_policy` alongside `response_policy`. Check
  `chat_memory_store` before starting work and prefer retrieving over
  re-deriving facts that are expensive to rediscover.
- Store facts that are expensive to rediscover: decisions, constraints,
  verified commands, and gotchas. Never store secrets or credentials.
- Memories are scoped to the current project by default. Pass `project` to
  override, or `project: "__global__"` for facts shared across projects.
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
- Thread one `request_id` through the tools in a logical flow (reuse the id
  `classify` returns). After gathering context, call `assess_context` with
  that id to ask whether the signal is sufficient and what to gather next.

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
