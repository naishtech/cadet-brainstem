# 42 - Recommended-Tool Hooks (full lifecycle)

## Goal

Give the downstream LM a mechanical nudge to use the classifier's
`recommended_tools` even when it ignores the `classify` JSON, and save tokens at
every point in the agent session. Mirror Serena's VS Code Copilot Chat Hooks
setup but extend it to **all eight** lifecycle events.

## Why

`classify` returns `tool_plan.recommended_tools` and a `follow_tool_plan`
directive, but MCP is client-driven — the server cannot force a tool call. In
real sessions the cloud LM over-used `grep_search`/`read_file` and ignored
`find_relevant_symbols`, and a global PreToolUse hook fired with "Too many
consecutive grep calls without using symbolic tools". This task makes that
guardrail first-class: the CLI installs a full-lifecycle hook config and
provides a handler per lifecycle event.

## Deliverables

### 1. `hooks` command — `src/cli/commands/hooks.ts`

- `cadet-token-saver hooks [tool] [--tool <name>] [--out <dir>]` — installs all
  lifecycle events in one command.
- Writes `<outDir>/cadet-token-saver.json` (default `~/.copilot/hooks`, the
  directory VS Code auto-loads Copilot Chat Hooks from):
  ```json
  {
    "hooks": {
      "SessionStart":     [{ "type": "command", "command": "cadet-token-saver hook-session-start" }],
      "UserPromptSubmit": [{ "type": "command", "command": "cadet-token-saver hook-user-prompt" }],
      "PreToolUse":       [{ "type": "command", "command": "cadet-token-saver hook-remind --tool <tool>" }],
      "PostToolUse":      [{ "type": "command", "command": "cadet-token-saver hook-post-tool" }],
      "PreCompact":       [{ "type": "command", "command": "cadet-token-saver hook-pre-compact" }],
      "SubagentStart":    [{ "type": "command", "command": "cadet-token-saver hook-subagent-start" }],
      "SubagentStop":     [{ "type": "command", "command": "cadet-token-saver hook-subagent-stop" }],
      "Stop":             [{ "type": "command", "command": "cadet-token-saver hook-stop" }]
    }
  }
  ```
- Default recommended tool: `find_relevant_symbols`.
- Exports: `HOOK_EVENTS`, `parseHooksArgs`, `buildHooksConfig`,
  `defaultHooksFilePath`, `runHooks`, `hooksCommand`.

### 2. `hook-remind` handler — `src/cli/commands/hook-remind.ts`

- `cadet-token-saver hook-remind [--tool <name>]` (PreToolUse).
- Reads the VS Code PreToolUse payload from stdin, updates a per-session
  persisted counter (default `~/.local/state/cadet-token-saver/hooks/<session>.json`),
  and emits `{ hookSpecificOutput: { permissionDecision } }`.
- Thresholds: `GREP_THRESHOLD = 3`, `READ_THRESHOLD = 3`,
  `NON_SYMBOLIC_THRESHOLD = 4`. Using a symbolic tool (serena /
  find_relevant_symbols / leanctx / optimize_context / find_symbol) resets the
  counters. The matcher is unrestricted so proxied `mcp_cadet-token-s_*`
  serena/leanctx tools are seen and reset the counter.
- Deny message includes the recommended tool name.

### 3. Lifecycle handlers — `src/cli/commands/hook-lifecycle.ts`

One command per lifecycle event, all best-effort (never break the session):

| Command | Event | Behaviour |
| --- | --- | --- |
| `hook-session-start` | `SessionStart` | Prime session with memory hints + recommended tool |
| `hook-user-prompt` | `UserPromptSubmit` | `classifyWithFallback(prompt)`, inject strategy + tool plan |
| `hook-post-tool` | `PostToolUse` | Record token metrics per tool call |
| `hook-pre-compact` | `PreCompact` | Store a memory checkpoint + inject preserve-evidence reminder |
| `hook-subagent-start` | `SubagentStart` | Classify subtask, inject cheap-path primer |
| `hook-subagent-stop` | `SubagentStop` | Record nested usage, clean up state |
| `hook-stop` | `Stop` | Store session summary, record metrics, clean up state |

### 4. Wiring

- Register all commands in `src/cli/commands.ts`.
- Update `test/cli.test.ts` command list.
- Tests: `test/hooks-command.test.ts`, `test/hook-lifecycle.test.ts`.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- `hooks` installs all eight events into `~/.copilot/hooks/cadet-token-saver.json`
  by default (overridable with `--out`).
- `hook-remind` allows below threshold, denies at threshold, resets after
  symbolic-tool use and after a deny, and is a no-op on empty stdin.
- Each lifecycle handler reads the payload, writes a valid hook output, and
  degrades gracefully (best-effort memory/metrics).
